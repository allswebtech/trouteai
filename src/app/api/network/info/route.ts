import os from "os";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { getRuntimePorts } from "@/lib/runtime/ports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { apiPort } = getRuntimePorts();
  const interfaces = os.networkInterfaces();
  const localUrl = `http://localhost:${apiPort}/v1`;
  const lanUrls: string[] = [];

  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      lanUrls.push(`http://${addr.address}:${apiPort}/v1`);
    }
  }

  return NextResponse.json({ localUrl, lanUrls });
}
