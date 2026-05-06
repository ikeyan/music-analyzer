import { createClient } from "honox/client";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";

// island は `import { useState } from "react"` しているので、honox 標準の hono/jsx/dom
// hydrate だと ReactCurrentDispatcher が未設定で useState が落ちる。
// honox の Hydrate 型は hono/jsx 前提で React と shape が合わないのでキャスト
createClient({
  createElement: createElement as never,
  hydrate: ((children: unknown, element: Element) => {
    hydrateRoot(element, children as never);
  }) as never,
});
