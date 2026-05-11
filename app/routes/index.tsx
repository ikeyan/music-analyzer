import { createRoute } from "honox/factory";

export default createRoute((c) => {
  return c.render(
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>music-analyzer</h1>
      <p>music-analyzer / bun + hono + honox + react + prisma + sqlite</p>
      <p>
        <a href="/projects">プロジェクト一覧へ</a>
      </p>
    </main>,
    { title: "music-analyzer" },
  );
});
