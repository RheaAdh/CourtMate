"use client";

type TennisBallLoaderProps = {
  label?: string;
  detail?: string;
  compact?: boolean;
};

export function TennisBallLoader({ label, detail, compact = false }: TennisBallLoaderProps) {
  return <div className={`tennis-loader ${compact ? "compact" : ""}`} role="status" aria-live="polite" aria-label={label ?? "Loading"}>
    <span className="tennis-loader-orbit" aria-hidden="true"><span className="tennis-loader-ball" /><i /><i /></span>
    {(label || detail) && <span className="tennis-loader-copy">{label && <strong>{label}</strong>}{detail && <span>{detail}</span>}</span>}
  </div>;
}
