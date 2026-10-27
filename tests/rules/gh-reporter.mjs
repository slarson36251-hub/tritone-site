// node --test reporter for CI: every failing rules test becomes a GitHub annotation (::error), so the
// reason shows on the pull request even when the job log can't be opened. Locally it prints nothing extra.
export default async function* ghReporter(source) {
  for await (const ev of source) {
    if (ev.type !== "test:fail" || !process.env.GITHUB_ACTIONS) continue;
    const err = ev.data.details?.error;
    const msg = String(err?.cause?.message ?? err?.message ?? err ?? "failed").replace(/\r?\n/g, " ").slice(0, 900);
    yield `::error title=Rules test failed: ${ev.data.name.replace(/[:,\r\n]/g, " ")}::${msg}\n`;
  }
}
