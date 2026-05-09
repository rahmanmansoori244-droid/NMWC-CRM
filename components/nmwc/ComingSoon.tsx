import { PageHeader } from './PageHeader';

export function ComingSoon({
  title,
  milestone,
  description,
}: {
  title: string;
  milestone: string;
  description?: string;
}) {
  return (
    <main>
      <PageHeader title={title} subtitle={milestone} />
      <div className="p-6">
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
          <p className="text-base font-semibold text-slate-900">In progress</p>
          <p className="mt-2 mx-auto max-w-md text-sm text-slate-600">
            {description ??
              `This page is part of ${milestone}. The route is wired and the data model supports it; the UI lands in the milestone shown above.`}
          </p>
        </div>
      </div>
    </main>
  );
}
