import { createRoute } from "honox/factory";
import { requireUser } from "../../lib/auth";
import { prisma } from "../../lib/prisma";
import ProjectList from "../../islands/project-list";

export default createRoute(requireUser, async (c) => {
  const user = c.var.user;
  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { videos: true, audios: true } } },
  });

  const initial = projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    videoCount: p._count.videos,
    audioCount: p._count.audios,
  }));

  return c.render(
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: 800,
        margin: "0 auto",
      }}
    >
      <h1>プロジェクト</h1>
      <p style={{ color: "#666" }}>
        signed in as {user.username ?? user.email ?? user.authentikSub}
      </p>
      <ProjectList initial={initial} />
    </main>,
    { title: "プロジェクト一覧 - music-analyzer" },
  );
});
