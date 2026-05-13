import { describe, expect, it } from "bun:test";
import { useDbFixture } from "../test-fixtures/db";
import { useFrontend, waitFor } from "../test-fixtures/frontend";
import { useMediaFixture } from "../test-fixtures/media";
import { useS3Fixture } from "../test-fixtures/s3";

useDbFixture();
useS3Fixture();
const getMedia = useMediaFixture();
const { webview, server, goto } = useFrontend();

async function createProject(name: string): Promise<string> {
  const res = await fetch(`${server()}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createProject ${res.status}`);
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
}

// File 入力に file を流し込むのは headless browser で OS file picker を踏まないよう、
// page 内で File オブジェクトを構築して input.files を native setter 経由で書き換える。
// File picker dialog は webview API では開けないのでこの形が一番素直
async function injectFileToInput(
  filePath: string,
  accept: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const buf = await Bun.file(filePath).arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  await webview().evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
    const input = document.querySelector('input[type=file][accept=' + ${JSON.stringify(JSON.stringify(accept))} + ']');
    if (!input) throw new Error("file input not found: accept=" + ${JSON.stringify(accept)});
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
    setter.call(input, dt.files);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

// hydration が終わるまで poll。SSR 直後は React の onChange が attach されていないので
// file injection より前に必ず待つ
async function waitHydrated(selector: string, timeoutMs = 10_000): Promise<void> {
  await webview().evaluate(`new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el && Object.keys(el).some(k => k.startsWith("__reactFiber"))) return res();
      if (Date.now() - start > ${timeoutMs}) return rej(new Error("hydration timeout: " + ${JSON.stringify(selector)}));
      setTimeout(tick, 30);
    };
    tick();
  })`);
}

describe("ProjectDetail (frontend)", () => {
  it("音声ファイルを upload すると <audio> source に stream URL が入る", async () => {
    const id = await createProject("audio-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "test.mp3", "audio/mpeg");
    // upload + ffmpeg transcode + S3 + DB + refresh
    await waitFor(webview(), "audio source", 30_000);
    const src = await webview().evaluate<string>(
      `document.querySelector('audio source').getAttribute('src') ?? ""`,
    );
    expect(src).toMatch(/\/api\/projects\/[^/]+\/audios\/[^/]+\/stream$/);
  }, 60_000);

  it("動画ファイルを upload すると <video> に stream URL が入る", async () => {
    const id = await createProject("video-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="video/*"]');
    await injectFileToInput(getMedia().videoMp4, "video/*", "test.mp4", "video/mp4");
    await waitFor(webview(), "video[src]", 60_000);
    const src = await webview().evaluate<string>(
      `document.querySelector('video').getAttribute('src') ?? ""`,
    );
    expect(src).toMatch(/\/api\/projects\/[^/]+\/videos\/[^/]+\/stream$/);
  }, 90_000);

  it("音声 upload 後に再生ボタンを押すと audio.currentTime が進み、一時停止で止まる", async () => {
    const id = await createProject("playback-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "test.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    // <audio> が canplay になるまで待ってから user-gesture click を撃つ
    await webview().evaluate(`new Promise((res, rej) => {
      const audio = document.querySelector('audio');
      if (!audio) return rej(new Error("no audio"));
      if (audio.readyState >= 2) return res();
      const t = setTimeout(() => rej(new Error("audio canplay timeout")), 5000);
      audio.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
      audio.load();
    })`);
    // synthetic btn.click() は autoplay policy の user gesture にならないので
    // webview.click(selector) で CDP 経由の input event を撃つ
    await webview().click('button[aria-label="play"]');
    const advanced = await webview().evaluate<number>(`new Promise(res => {
      const audio = document.querySelector('audio');
      const start = Date.now();
      const tick = () => {
        if (audio && audio.currentTime > 0) return res(audio.currentTime);
        if (Date.now() - start > 3000) return res(audio?.currentTime ?? 0);
        setTimeout(tick, 50);
      };
      tick();
    })`);
    expect(advanced).toBeGreaterThan(0);
    // 一時停止で audio.paused が true になり currentTime が止まる
    await webview().click('button[aria-label="pause"]');
    const before = await webview().evaluate<number>(`document.querySelector('audio').currentTime`);
    await Bun.sleep(300);
    const after = await webview().evaluate<{ time: number; paused: boolean }>(
      `({ time: document.querySelector('audio').currentTime, paused: document.querySelector('audio').paused })`,
    );
    expect(after.paused).toBe(true);
    // 300ms の grace 内に 50ms 以上前進していなければ止まったとみなす
    expect(Math.abs(after.time - before)).toBeLessThan(0.05);
  }, 60_000);

  it("track の ↑↓ ボタンで並び替えると order が入れ替わる", async () => {
    const id = await createProject("reorder-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "first.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "second.mp3", "audio/mpeg");
    // 2 audio source が出るまで poll
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("second audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    // 「first を下に移動」をクリック → first と second が swap
    await webview().click('button[aria-label="first.mp3 を下に移動"]');
    // refresh で API から取り直したあと name の順序を見る (order asc で並ぶ)
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        const names = Array.from(document.querySelectorAll('honox-island span'))
          .map(s => s.textContent ?? "")
          .filter(t => t.includes(".mp3"));
        if (names.length >= 2 && names[0].includes("second") && names[1].includes("first")) return res();
        if (Date.now() - start > 5000) return rej(new Error("reorder not reflected: " + JSON.stringify(names)));
        setTimeout(tick, 50);
      };
      tick();
    })`);
  }, 90_000);

  it("非メディアファイルを upload すると HTTP status と branch 別エラー文言が画面に出る", async () => {
    const id = await createProject("error-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // 適当な非メディア bytes をぶつけて ffprobe failure 経路を踏ませる
    await webview().evaluate(`(() => {
      const bytes = new TextEncoder().encode("not a media file");
      const file = new File([bytes], "garbage.bin", { type: "application/octet-stream" });
      const input = document.querySelector('input[type=file][accept="audio/*"]');
      const dt = new DataTransfer();
      dt.items.add(file);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
      setter.call(input, dt.files);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(webview(), 'p[role="alert"]', 30_000);
    const errText = await webview().evaluate<string>(
      `document.querySelector('p[role="alert"]').textContent ?? ""`,
    );
    // status + branch を識別できる文言が両方含まれる
    expect(errText).toContain("HTTP 400");
    expect(errText).toContain("could not parse uploaded file");
  }, 60_000);

  it("削除ボタンで track が消える", async () => {
    const id = await createProject("delete-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // confirm() を auto-accept する
    await webview().evaluate(`window.confirm = () => true`);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "delete-me.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await webview().click('button[aria-label="delete-me.mp3 を削除"]');
    // refresh 後 <audio> が DOM から消える
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length === 0) return res();
        if (Date.now() - start > 5000) return rej(new Error("audio still present"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
  }, 60_000);

  it("編集ポップアップの直接入力で projStart/End が更新される", async () => {
    const id = await createProject("edit-direct-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "direct.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await webview().click('button[aria-label="direct.mp3 を編集"]');
    await waitFor(webview(), 'div[role="dialog"]');
    // input[0]=倍率, [1]=projStart, [2]=projEnd の順に並ぶ
    await webview().evaluate(`(() => {
      const inputs = document.querySelectorAll('div[role="dialog"] input[type=number]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(inputs[1], "10");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(inputs[2], "15");
      inputs[2].dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    // 「直接入力」セクションの「適用」を押す
    await webview().evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button'));
      const apply = buttons.filter(b => b.textContent === "適用")[1];
      if (!apply) throw new Error("直接入力の適用ボタンが見つからない");
      apply.click();
    })()`);
    // dialog が閉じるのを待ち、API で値を検証
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (!document.querySelector('div[role="dialog"]')) return res();
        if (Date.now() - start > 5000) return rej(new Error("dialog still open"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    const detail = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const audio = detail.project.audios.find((a) => a.name === "direct.mp3");
    expect(audio).toBeDefined();
    expect(audio!.projStartSec).toBeCloseTo(10, 3);
    expect(audio!.projEndSec).toBeCloseTo(15, 3);
  }, 60_000);

  it("編集ポップアップの時間反転で projStart/End が入れ替わる", async () => {
    const id = await createProject("edit-flip-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "flip.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    const before = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const a0 = before.project.audios.find((a) => a.name === "flip.mp3")!;
    await webview().click('button[aria-label="flip.mp3 を編集"]');
    await waitFor(webview(), 'div[role="dialog"]');
    await webview().evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button'));
      const flip = buttons.find(b => b.textContent === "反転");
      if (!flip) throw new Error("反転 ボタンが見つからない");
      flip.click();
    })()`);
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (!document.querySelector('div[role="dialog"]')) return res();
        if (Date.now() - start > 5000) return rej(new Error("dialog still open"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    const after = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const a1 = after.project.audios.find((a) => a.name === "flip.mp3")!;
    expect(a1.projStartSec).toBeCloseTo(a0.projEndSec, 3);
    expect(a1.projEndSec).toBeCloseTo(a0.projStartSec, 3);
  }, 60_000);

  it("編集ポップアップの移動・拡縮で別メディアの開始時刻に揃う", async () => {
    const id = await createProject("edit-align-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "first.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "second.mp3", "audio/mpeg");
    // 2 audio を待つ
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("second audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    // second の編集ダイアログを開き、基準=first, 配置=same-start で適用
    await webview().click('button[aria-label="second.mp3 を編集"]');
    await waitFor(webview(), 'div[role="dialog"]');
    await webview().evaluate(`(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      const selects = dlg.querySelectorAll('select');
      const anchorSel = selects[0]; // 基準
      const patternSel = selects[1]; // 配置
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      const firstOption = Array.from(anchorSel.options).find(o => o.textContent && o.textContent.includes("first.mp3"));
      if (!firstOption) throw new Error("first.mp3 option not found");
      setter.call(anchorSel, firstOption.value);
      anchorSel.dispatchEvent(new Event("change", { bubbles: true }));
      setter.call(patternSel, "same-start");
      patternSel.dispatchEvent(new Event("change", { bubbles: true }));
      // 移動・拡縮 セクションの最初の「適用」を押す
      const buttons = Array.from(dlg.querySelectorAll('button'));
      const apply = buttons.filter(b => b.textContent === "適用")[0];
      apply.click();
    })()`);
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (!document.querySelector('div[role="dialog"]')) return res();
        if (Date.now() - start > 5000) return rej(new Error("dialog still open"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    const after = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const first = after.project.audios.find((a) => a.name === "first.mp3")!;
    const second = after.project.audios.find((a) => a.name === "second.mp3")!;
    expect(second.projStartSec).toBeCloseTo(first.projStartSec, 3);
  }, 90_000);

  it("トリミングポップアップで srcStart/End が更新される", async () => {
    const id = await createProject("trim-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "trim.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await webview().click('button[aria-label="trim.mp3 をトリミング"]');
    await waitFor(webview(), 'div[role="dialog"]');
    await webview().evaluate(`(() => {
      const inputs = document.querySelectorAll('div[role="dialog"] input[type=number]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(inputs[0], "0.2");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(inputs[1], "0.5");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button'));
      const apply = buttons.find(b => b.textContent === "適用");
      if (!apply) throw new Error("適用 ボタンが見つからない");
      apply.click();
    })()`);
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (!document.querySelector('div[role="dialog"]')) return res();
        if (Date.now() - start > 5000) return rej(new Error("dialog still open"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    const detail = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; srcStartSec: number; srcEndSec: number }[] };
    };
    const audio = detail.project.audios.find((a) => a.name === "trim.mp3")!;
    expect(audio.srcStartSec).toBeCloseTo(0.2, 3);
    expect(audio.srcEndSec).toBeCloseTo(0.5, 3);
  }, 60_000);

  it("反転 track を含む状態で並び替えても向きを保ち back-to-back に並ぶ", async () => {
    const id = await createProject("reorder-flip-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "rev.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "fwd.mp3", "audio/mpeg");
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("second audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    const before = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { id: string; name: string; projStartSec: number; projEndSec: number }[] };
    };
    const rev = before.project.audios.find((a) => a.name === "rev.mp3")!;
    // rev を反転して projStart > projEnd にする
    const flipRes = await fetch(`${server()}/api/projects/${id}/audios/${rev.id}/timing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcStartSec: 0,
        srcEndSec: 1,
        projStartSec: rev.projEndSec,
        projEndSec: rev.projStartSec,
      }),
    });
    expect(flipRes.ok).toBe(true);
    // rev を下に移動 (rev.mp3 が order 0、fwd.mp3 が order 1 から、swap で fwd→rev に)
    await webview().click('button[aria-label="rev.mp3 を下に移動"]');
    // refresh を待ってから検証
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        const names = Array.from(document.querySelectorAll('honox-island span'))
          .map(s => s.textContent ?? "")
          .filter(t => t.includes(".mp3"));
        if (names.length >= 2 && names[0].includes("fwd") && names[1].includes("rev")) return res();
        if (Date.now() - start > 5000) return rej(new Error("reorder not reflected: " + JSON.stringify(names)));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    const after = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const afterFwd = after.project.audios.find((a) => a.name === "fwd.mp3")!;
    const afterRev = after.project.audios.find((a) => a.name === "rev.mp3")!;
    // fwd は order 0 で 0 から、rev は反転を維持しつつ fwd の直後に置かれる
    expect(afterFwd.projStartSec).toBeCloseTo(0, 3);
    expect(afterFwd.projEndSec).toBeGreaterThan(0);
    expect(afterRev.projStartSec).toBeGreaterThan(afterRev.projEndSec);
    expect(afterRev.projEndSec).toBeCloseTo(afterFwd.projEndSec, 3);
    expect(afterRev.projStartSec).toBeGreaterThanOrEqual(afterFwd.projEndSec);
  }, 90_000);

  it("反転 track の後に upload した media は反転 track と overlap しない", async () => {
    const id = await createProject("alloc-after-reversed-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "rev.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    const before = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { id: string; name: string; projStartSec: number; projEndSec: number }[] };
    };
    const rev = before.project.audios.find((a) => a.name === "rev.mp3")!;
    const revExtent = Math.max(rev.projStartSec, rev.projEndSec);
    // rev を反転 (projStart > projEnd)
    const flipRes = await fetch(`${server()}/api/projects/${id}/audios/${rev.id}/timing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcStartSec: 0,
        srcEndSec: 1,
        projStartSec: rev.projEndSec === 0 ? rev.projStartSec : revExtent,
        projEndSec: 0,
      }),
    });
    expect(flipRes.ok).toBe(true);
    // 反転後に新規 upload。allocSlot が max(start, end) を使えば revExtent 以後に置かれる
    await injectFileToInput(getMedia().audioMp3, "audio/*", "after.mp3", "audio/mpeg");
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("second audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    const after = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const afterMedia = after.project.audios.find((a) => a.name === "after.mp3")!;
    expect(afterMedia.projStartSec).toBeGreaterThanOrEqual(revExtent - 1e-6);
  }, 90_000);
});
