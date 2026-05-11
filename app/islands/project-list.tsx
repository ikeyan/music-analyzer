import { useState } from "react";
import type { ApiProjectSummary } from "../api/types";
import { apiClient } from "../lib/api-client";

export type ProjectSummary = ApiProjectSummary;

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
      const res = await apiClient.projects.$post({ json: { name } });
      if (!res.ok) {
        setError(`作成失敗 (HTTP ${res.status})`);
        return;
      }
      const body = await res.json();
      setItems((prev) => [{ ...body.project, videoCount: 0, audioCount: 0 }, ...prev]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("プロジェクトを削除しますか？")) return;
    const res = await apiClient.projects[":id"].$delete({ param: { id } });
    if (res.ok) {
      setItems((prev) => prev.filter((p) => p.id !== id));
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
