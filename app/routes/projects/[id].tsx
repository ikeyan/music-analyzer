import { createRoute } from "honox/factory";
import { requireUser } from "../../lib/auth";
import { prisma } from "../../lib/prisma";
import ProjectDetail, { type ProjectDetailData } from "../../islands/project-detail";

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

  const data: ProjectDetailData = {
    id: project.id,
    name: project.name,
    videos: project.videos.map((v) => ({
      id: v.id,
      name: v.name,
      order: v.order,
      durationSec: v.durationSec,
      width: v.width,
      height: v.height,
      fps: v.fps,
      sizeBytes: v.sizeBytes,
      srcStartSec: v.srcStartSec,
      srcEndSec: v.srcEndSec,
      projStartSec: v.projStartSec,
      projEndSec: v.projEndSec,
      streamUrl: `/api/projects/${project.id}/videos/${v.id}/stream`,
      audioUrl: v.audioKey ? `/api/projects/${project.id}/videos/${v.id}/audio` : null,
      thumbnails: v.thumbnails.map((t) => ({
        id: t.id,
        atSec: t.atSec,
        url: `/api/projects/${project.id}/videos/${v.id}/thumbnails/${t.id}`,
        width: t.width,
        height: t.height,
      })),
    })),
    audios: project.audios.map((a) => ({
      id: a.id,
      name: a.name,
      order: a.order,
      durationSec: a.durationSec,
      contentType: a.contentType,
      sampleRate: a.sampleRate,
      channels: a.channels,
      sizeBytes: a.sizeBytes,
      srcStartSec: a.srcStartSec,
      srcEndSec: a.srcEndSec,
      projStartSec: a.projStartSec,
      projEndSec: a.projEndSec,
      streamUrl: `/api/projects/${project.id}/audios/${a.id}/stream`,
    })),
  };

  return c.render(
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
      <ProjectDetail initial={data} />
    </main>,
    { title: `${project.name} - music-analyzer` },
  );
});
