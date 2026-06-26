import type { DocStatus } from "@workspace/api-client-react";
import { DOC_STATUS_STYLES } from "@/lib/package-ui";

export default function DocStatusBadge({ status }: { status: DocStatus }) {
  const style = DOC_STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
