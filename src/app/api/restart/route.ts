import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  // A restart only works when something starts the server again: the `trouteai` command does
  // (it runs the server as its child), or a supervisor the user names with
  // TROUTEAI_RESTART_SUPERVISED=true (a hosting panel, systemd with Restart=always).
  const byCommand = Boolean(process.env.__TROUTEAI_HEAP_CHILD);
  if (!byCommand && process.env.TROUTEAI_RESTART_SUPERVISED !== "true") {
    return createErrorResponse({
      status: 409,
      message:
        "This server was not started by the trouteai command, so nothing would start it again. " +
        "Stop it and start it again where you started it.",
      type: "invalid_request",
    });
  }

  // Graceful restart: SIGTERM flows through the shutdown handler. Started by the command, the
  // server then ends with the restart code and the command starts it again on the same port.
  if (byCommand) globalThis.__trouteaiRestart = true;
  setTimeout(() => {
    // On Windows a signal sent to oneself ends the process at once, without the drain and
    // without the restart code, so the stop handler is called in the process instead.
    if (process.platform === "win32") process.emit("SIGTERM", "SIGTERM");
    else process.kill(process.pid, "SIGTERM");
  }, 500);

  return NextResponse.json({ status: "restarting" });
}
