import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getWorkbenchOrigin, isWorkbenchEnabled } from "@/src/workbench/environment";
import WorkbenchClient from "./workbench-client";

export const dynamic = "force-dynamic";

export default async function WorkbenchPage() {
  const requestHeaders = await headers();
  const expectedOrigin = getWorkbenchOrigin();
  if (!isWorkbenchEnabled() || !expectedOrigin || requestHeaders.get("host") !== expectedOrigin.host) notFound();
  return <WorkbenchClient />;
}
