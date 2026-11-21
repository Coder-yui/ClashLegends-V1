import type { ReactNode } from "react";
import { FullscreenButton } from "./fullscreen";
import { href } from "./api";

export function MatchLoading({
  status = "正在连接战场…",
  error,
  progress,
  back,
  children,
}: {
  status?: string;
  error?: string;
  progress?: { completed: number; total: number };
  back?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="match-loading" aria-label="对局加载">
      <div className="loading-tools">
        {back}
        <FullscreenButton />
      </div>
      <div className="loading-status">
        <h1>{error ? "暂时无法进入对局" : "正在加载对局…"}</h1>
        <p role={error ? "alert" : "status"}>{error || status}</p>
        {!error && (
          <div
            className="loading-progress"
            role="progressbar"
            aria-label={status}
            aria-valuemin={0}
            aria-valuemax={progress?.total || 1}
            aria-valuenow={progress?.total ? progress.completed : undefined}
          >
            <span
              style={
                progress?.total
                  ? { width: (100 * progress.completed) / progress.total + "%" }
                  : undefined
              }
            />
          </div>
        )}
        {error && (
          <div className="footer-actions">
            {children}
            <a className="outline" href={href()}>
              返回大厅
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
