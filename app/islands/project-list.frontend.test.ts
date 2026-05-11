import { describe, expect, it } from "bun:test";
import { useDbFixture } from "../test-fixtures/db";
import { useFrontend, waitFor } from "../test-fixtures/frontend";

useDbFixture();
const { webview, goto } = useFrontend();

describe("ProjectList (frontend)", () => {
  it("空リストで empty state を render する (SSR)", async () => {
    await goto("/projects");
    await waitFor(webview(), "main p");
    const text = await webview().evaluate<string>("document.body.innerText");
    expect(text).toContain("まだプロジェクトがありません。");
  });

  it("作成ボタンで新規 project が一覧に出る", async () => {
    await goto("/projects");
    // hydration 待ち: React fiber が attach されるまで poll してから操作する
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        const input = document.querySelector("form input[type=text]");
        if (input && Object.keys(input).some(k => k.startsWith("__reactFiber"))) return res();
        if (Date.now() - start > 5000) return rej(new Error("hydration timeout"));
        setTimeout(tick, 30);
      };
      tick();
    })`);
    // React-controlled input — native setter で value を入れてから input event を撃つ
    await webview().evaluate(`(() => {
      const input = document.querySelector("form input[type=text]");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "テスト用プロジェクト");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    webview().click("form button[type=submit]");
    await waitFor(webview(), "ul li strong");
    const itemText = await webview().evaluate<string>(
      `document.querySelector("ul li strong").textContent`,
    );
    expect(itemText).toBe("テスト用プロジェクト");
  }, 15_000);
});
