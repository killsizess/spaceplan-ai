"use client";

import dynamic from "next/dynamic";
import { prepareLanguage } from "@/lib/i18n";
import { detectUnits, setUnits } from "@/lib/units";

/**
 * The language is settled before the app is imported, since its constants read it as they are
 * evaluated. The app is therefore rendered in the browser only: a static page cannot know
 * which language its reader wants, and text differing from the page would not hydrate.
 */
const Editor = dynamic(
  async () => {
    await prepareLanguage();
    setUnits(detectUnits());
    return import("./editor");
  },
  { ssr: false, loading: () => <div className="app-loading" aria-busy="true">SpacePlan AI</div> },
);

export default function AppShell() {
  return <Editor />;
}
