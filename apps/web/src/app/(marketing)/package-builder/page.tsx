import { getServices } from "@/lib/api";
import { PackageBuilder } from "./package-builder";

export const metadata = { title: "Package builder | BMU Marketing" };
export const revalidate = 60;

export default async function PackageBuilderPage() {
  const { data } = await getServices();
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
      <h1 className="font-display text-3xl">Build your package</h1>
      <p className="mt-2 text-ink-muted">
        Pick services and a tier for each. Choose a full bundle and you save 10% automatically. GST (18%) is shown separately.
      </p>
      <PackageBuilder services={data} />
    </main>
  );
}
