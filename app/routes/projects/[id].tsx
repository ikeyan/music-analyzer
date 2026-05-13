import { Either } from "effect";
import { createRoute } from "honox/factory";
import { requireProjectDetail } from "../../api/projects";
import { toApiProjectDetail } from "../../api/types";
import ProjectDetail from "../../islands/project-detail";
import { requireUser } from "../../lib/auth";

export default createRoute(requireUser, async (c) => {
  const user = c.var.user;
  const id = c.req.param("id");
  if (!id) return c.notFound();
  const r = await requireProjectDetail(user.id, id);
  if (Either.isLeft(r)) return c.notFound();
  const project = r.right;

  return c.render(
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem" }}>
      <ProjectDetail initial={toApiProjectDetail(project)} />
    </main>,
    { title: `${project.name} - music-analyzer` },
  );
});
