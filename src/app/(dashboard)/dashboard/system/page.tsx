import { redirect } from "next/navigation";

// "System" only contains the proxy settings page; keep breadcrumb links working.
export default function SystemPage() {
  redirect("/dashboard/system/proxy");
}
