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

  it("末尾まで再生後に再生ボタンを押すと先頭から再生し直す", async () => {
    const id = await createProject("replay-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "replay.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await webview().evaluate(`new Promise((res, rej) => {
      const a = document.querySelector('audio');
      if (!a) return rej(new Error("no audio"));
      if (a.readyState >= 2) return res();
      const t = setTimeout(() => rej(new Error("canplay timeout")), 5000);
      a.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
      a.load();
    })`);
    await webview().click('button[aria-label="play"]');
    // 末尾到達で自動停止 (aria-label が pause→play に戻る) し、audio が末尾側まで進むのを待つ
    const endedTime = await webview().evaluate<number>(`new Promise((res, rej) => {
      const start = Date.now();
      let wasPlaying = false;
      const tick = () => {
        const a = document.querySelector('audio');
        if (document.querySelector('button[aria-label="pause"]')) wasPlaying = true;
        if (wasPlaying && document.querySelector('button[aria-label="play"]')) return res(a?.currentTime ?? 0);
        if (Date.now() - start > 10000) return rej(new Error("playback did not finish"));
        setTimeout(tick, 50);
      };
      tick();
    })`);
    // 末尾側まで再生できていた
    expect(endedTime).toBeGreaterThan(0.4);
    // もう一度再生 → 先頭に戻って再生し直す
    await webview().click('button[aria-label="play"]');
    const minSeen = await webview().evaluate<number>(`new Promise(res => {
      const a = document.querySelector('audio');
      const start = Date.now();
      let m = Infinity;
      const tick = () => {
        if (a) m = Math.min(m, a.currentTime);
        if (Date.now() - start > 1500) return res(m);
        setTimeout(tick, 30);
      };
      tick();
    })`);
    // 末尾値ではなく先頭付近から鳴り直している
    expect(minSeen).toBeLessThan(0.3);
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

  it("非メディアファイルを upload すると task list に失敗とエラー文言が出る", async () => {
    const id = await createProject("error-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // 適当な非メディア bytes をぶつけて ffprobe failure 経路を踏ませる。
    // /complete は通り、task が失敗するので task list に "失敗" として出る
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
    await waitFor(webview(), '[role="alert"]', 30_000);
    const taskText = await webview().evaluate<string>(
      `(document.querySelector('section[aria-label="処理中のタスク"]')?.textContent ?? "")`,
    );
    expect(taskText).toContain("garbage.bin");
    expect(taskText).toContain("失敗");
    expect(taskText).toContain("could not parse uploaded file");
  }, 60_000);

  it("upload 中にリロードしても task list に処理中タスクが残る", async () => {
    const id = await createProject("reload-task");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "reload-tone.mp3", "audio/mpeg");
    // task が出たらすぐリロード (succeeded で消えてしまう前に)
    await waitFor(webview(), 'section[aria-label="処理中のタスク"]', 30_000);
    await goto(`/projects/${id}`);
    // リロード後も処理中タスクの fileName / kind ラベルが表示される or 既に audio に
    // 昇格して timeline に出ている (どちらでも UX 上 OK)
    const result = await webview().evaluate<{ task: string; hasAudio: boolean }>(`(() => {
      const taskSection = document.querySelector('section[aria-label="処理中のタスク"]');
      return {
        task: taskSection?.textContent ?? "",
        hasAudio: document.querySelector("audio source") !== null,
      };
    })()`);
    if (!result.hasAudio) {
      expect(result.task).toContain("reload-tone.mp3");
    }
    await waitFor(webview(), "audio source", 30_000);
  }, 90_000);

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
      project: {
        audios: {
          name: string;
          srcStartSec: number;
          srcEndSec: number;
          projStartSec: number;
          projEndSec: number;
        }[];
      };
    };
    const audio = detail.project.audios.find((a) => a.name === "trim.mp3")!;
    expect(audio.srcStartSec).toBeCloseTo(0.2, 3);
    expect(audio.srcEndSec).toBeCloseTo(0.5, 3);
    // 再生速度を保つため proj 区間も新しい src 長 0.3s に合わせて縮む
    expect(audio.projEndSec - audio.projStartSec).toBeCloseTo(0.3, 3);
  }, 60_000);

  it("並び替えは表示順だけ変え、各 media の時間軸位置 (timing) は動かさない", async () => {
    const id = await createProject("reorder-timing-test");
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
    // 並び替え直前の各 timing を控える (UI state に反映させるため再取得)
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await webview().evaluate(`new Promise((res, rej) => {
      const start = Date.now();
      const tick = () => {
        if (document.querySelectorAll('audio').length >= 2) return res();
        if (Date.now() - start > 30000) return rej(new Error("audio timeout"));
        setTimeout(tick, 100);
      };
      tick();
    })`);
    const mid = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { name: string; projStartSec: number; projEndSec: number }[] };
    };
    const midFwd = mid.project.audios.find((a) => a.name === "fwd.mp3")!;
    const midRev = mid.project.audios.find((a) => a.name === "rev.mp3")!;
    // rev を下に移動 (rev order 0、fwd order 1 から swap で表示順 fwd→rev に)
    await webview().click('button[aria-label="rev.mp3 を下に移動"]');
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
    // 表示順は変わったが timing は据え置き (反転も維持)
    expect(afterFwd.projStartSec).toBeCloseTo(midFwd.projStartSec, 3);
    expect(afterFwd.projEndSec).toBeCloseTo(midFwd.projEndSec, 3);
    expect(afterRev.projStartSec).toBeCloseTo(midRev.projStartSec, 3);
    expect(afterRev.projEndSec).toBeCloseTo(midRev.projEndSec, 3);
    expect(afterRev.projStartSec).toBeGreaterThan(afterRev.projEndSec);
  }, 90_000);

  it("反転 target に「終了直後」を適用すると visually anchor の直後に置かれる", async () => {
    const id = await createProject("align-after-reversed-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "anchor.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "target.mp3", "audio/mpeg");
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
    const anchor = before.project.audios.find((a) => a.name === "anchor.mp3")!;
    const target = before.project.audios.find((a) => a.name === "target.mp3")!;
    const anchorHigh = Math.max(anchor.projStartSec, anchor.projEndSec);
    const targetAbsDur = Math.abs(target.projEndSec - target.projStartSec);
    // target を反転
    const flipRes = await fetch(`${server()}/api/projects/${id}/audios/${target.id}/timing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcStartSec: 0,
        srcEndSec: 1,
        projStartSec:
          target.projEndSec === 0
            ? target.projStartSec
            : Math.max(target.projStartSec, target.projEndSec),
        projEndSec: Math.min(target.projStartSec, target.projEndSec),
      }),
    });
    expect(flipRes.ok).toBe(true);
    // flip は直接 API で済ませたので SSR 再取得して React state に反映させる
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    // 編集ダイアログで基準=anchor, 配置=after, 倍率=1 で適用
    await webview().click('button[aria-label="target.mp3 を編集"]');
    await waitFor(webview(), 'div[role="dialog"]');
    await webview().evaluate(`(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      const selects = dlg.querySelectorAll('select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      const anchorOpt = Array.from(selects[0].options).find(o => o.textContent && o.textContent.includes("anchor.mp3"));
      if (!anchorOpt) throw new Error("anchor option not found");
      setter.call(selects[0], anchorOpt.value);
      selects[0].dispatchEvent(new Event("change", { bubbles: true }));
      setter.call(selects[1], "after");
      selects[1].dispatchEvent(new Event("change", { bubbles: true }));
      const apply = Array.from(dlg.querySelectorAll('button')).filter(b => b.textContent === "適用")[0];
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
    const afterTarget = after.project.audios.find((a) => a.name === "target.mp3")!;
    const targetLow = Math.min(afterTarget.projStartSec, afterTarget.projEndSec);
    const targetHigh = Math.max(afterTarget.projStartSec, afterTarget.projEndSec);
    // 反転が保たれ、visually anchor の直後に置かれる
    expect(afterTarget.projStartSec).toBeGreaterThan(afterTarget.projEndSec);
    expect(targetLow).toBeCloseTo(anchorHigh, 3);
    expect(targetHigh).toBeCloseTo(anchorHigh + targetAbsDur, 3);
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

  it("timing PATCH は projStartSec/projEndSec が上限超過なら 400", async () => {
    const id = await createProject("timing-cap-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "cap.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    const before = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: { audios: { id: string }[] };
    };
    const audioId = before.project.audios[0]!.id;
    const res = await fetch(`${server()}/api/projects/${id}/audios/${audioId}/timing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcStartSec: 0,
        srcEndSec: 1,
        projStartSec: 0,
        projEndSec: 1e9,
      }),
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it("track-order PATCH は absDur 合計が上限を超えるなら 400", async () => {
    const id = await createProject("reorder-cap-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "a.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    await injectFileToInput(getMedia().audioMp3, "audio/*", "b.mp3", "audio/mpeg");
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
      project: { audios: { id: string; name: string }[] };
    };
    // 2 track をそれぞれ cap 近くまで伸ばす (16h 相当, srcEndSec=1 は audio fixture 上限)
    for (const a of before.project.audios) {
      const r = await fetch(`${server()}/api/projects/${id}/audios/${a.id}/timing`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          srcStartSec: 0,
          srcEndSec: 1,
          projStartSec: 0,
          projEndSec: 16 * 60 * 60,
        }),
      });
      expect(r.ok).toBe(true);
    }
    // reorder すると 16h * 2 = 32h で 24h cap 超過 → 400
    const reorderRes = await fetch(`${server()}/api/projects/${id}/track-order`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tracks: before.project.audios.toReversed().map((a) => ({ kind: "audio", id: a.id })),
      }),
    });
    expect(reorderRes.status).toBe(400);
  }, 90_000);

  it("反転 audio は再生中 frame seek で <audio>.currentTime が src 末尾側に飛ぶ", async () => {
    const id = await createProject("reverse-seek-test");
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await injectFileToInput(getMedia().audioMp3, "audio/*", "rseek.mp3", "audio/mpeg");
    await waitFor(webview(), "audio source", 30_000);
    const before = (await fetch(`${server()}/api/projects/${id}`).then((r) => r.json())) as {
      project: {
        audios: {
          id: string;
          name: string;
          durationSec: number;
          projStartSec: number;
          projEndSec: number;
        }[];
      };
    };
    const a = before.project.audios[0]!;
    // proj を反転 (projStart=duration, projEnd=0)
    const flipRes = await fetch(`${server()}/api/projects/${id}/audios/${a.id}/timing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcStartSec: 0,
        srcEndSec: a.durationSec,
        projStartSec: a.durationSec,
        projEndSec: 0,
      }),
    });
    expect(flipRes.ok).toBe(true);
    await goto(`/projects/${id}`);
    await waitHydrated('input[type=file][accept="audio/*"]');
    await waitFor(webview(), "audio source", 30_000);
    await webview().evaluate(`new Promise((res, rej) => {
      const audio = document.querySelector('audio');
      if (!audio) return rej(new Error("no audio"));
      if (audio.readyState >= 2) return res();
      const t = setTimeout(() => rej(new Error("audio canplay timeout")), 5000);
      audio.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
      audio.load();
    })`);
    await webview().click('button[aria-label="play"]');
    // proj 0 で開始 → mediaT = srcEnd, seek で currentTime が末尾近くへ飛ぶ
    const seeked = await webview().evaluate<number>(`new Promise(res => {
      const audio = document.querySelector('audio');
      const start = Date.now();
      const tick = () => {
        if (audio && audio.currentTime > 0.5) return res(audio.currentTime);
        if (Date.now() - start > 3000) return res(audio?.currentTime ?? 0);
        setTimeout(tick, 50);
      };
      tick();
    })`);
    expect(seeked).toBeGreaterThan(0.5);
  }, 60_000);
});
