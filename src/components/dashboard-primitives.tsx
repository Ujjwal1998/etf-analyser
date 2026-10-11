import type { ChangeEvent } from "react";

export function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="metric"><p>{label}</p><strong>{value}</strong>{detail && <span>{detail}</span>}</article>;
}

export function PanelHeading({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: string }) {
  return <div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h3>{title}</h3></div>{aside && <span className="muted">{aside}</span>}</div>;
}

export function MetricSelect({ value, options, onChange }: { value: string; options: Record<string, string>; onChange: (event: ChangeEvent<HTMLSelectElement>) => void }) {
  return <label className="metric-select"><span>View metric</span><select value={value} onChange={onChange} aria-label="Benchmark table metric">{Object.entries(options).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>;
}
