import { useState } from "react";

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  videoCount: number;
  audioCount: number;
};

export default function ProjectList({ initial }: { initial: ProjectSummary[] }) {
  const [items, setItems] = useState(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(`作成失敗 (HTTP ${res.status})`);
        return;
      }
      const body = (await res.json()) as {
        project: { id: string; name: string; createdAt: string };
      };
      setItems([
        {
          id: body.project.id,
          name: body.project.name,
          createdAt: body.project.createdAt,
          videoCount: 0,
          audioCount: 0,
        },
        ...items,
      ]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("プロジェクトを削除しますか？")) return;
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setItems(items.filter((p) => p.id !== id));
    } else {
      setError(`削除失敗 (HTTP ${res.status})`);
    }
  }

  return (
    <div>
      <form
        onSubmit={create}
        style={{ display: "flex", gap: "0.5rem", margin: "1rem 0", alignItems: "center" }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新しいプロジェクト名"
          disabled={busy}
          style={{ flex: 1, padding: "0.4rem", fontSize: "1rem" }}
        />
        <button type="submit" disabled={busy || !name.trim()}>
          作成
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {items.length === 0 ? (
        <p>まだプロジェクトがありません。</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {items.map((p) => (
            <li
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                padding: "0.75rem",
                borderBottom: "1px solid #eee",
              }}
            >
              <a
                href={`/projects/${p.id}`}
                style={{ flex: 1, textDecoration: "none", color: "inherit" }}
              >
                <strong>{p.name}</strong>
                <div style={{ fontSize: "0.85rem", color: "#666" }}>
                  videos: {p.videoCount} / audios: {p.audioCount} / created:{" "}
                  {new Date(p.createdAt).toLocaleString()}
                </div>
              </a>
              <button type="button" onClick={() => remove(p.id)} style={{ color: "crimson" }}>
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
