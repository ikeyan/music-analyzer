import { createRoute } from "honox/factory";
import { toApiProjectDetail } from "../../api/types";
import { requireUser } from "../../lib/auth";
import { prisma } from "../../lib/prisma";
import ProjectDetail from "../../islands/project-detail";

export default createRoute(requireUser, async (c) => {
  const user = c.var.user;
  const id = c.req.param("id");
  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    include: {
      videos: { orderBy: { order: "asc" }, include: { thumbnails: { orderBy: { atSec: "asc" } } } },
      audios: { orderBy: { order: "asc" } },
    },
  });
  if (!project) return c.notFound();

  return c.render(
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
      <ProjectDetail initial={toApiProjectDetail(project)} />
    </main>,
    { title: `${project.name} - music-analyzer` },
  );
});
