"use client";

import type { ReactNode } from "react";
import ThemeToggle from "../ThemeToggle";

type AuthLayoutProps = {
  children: ReactNode;
};

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden bg-bg selection:bg-primary/20">
      {/* Theme toggle */}
      <div className="absolute end-4 top-4 z-20 sm:end-6 sm:top-6">
        <ThemeToggle variant="card" />
      </div>

      {/* Content */}
      <main className="z-10 flex h-full w-full flex-1 flex-col items-center justify-center p-4 sm:p-6">
        {children}
      </main>
    </div>
  );
}
