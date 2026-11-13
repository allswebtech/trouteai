"use client";

import { cn } from "@/shared/utils/cn";

interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  children?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: string;
  action?: React.ReactNode;
  padding?: "none" | "xs" | "sm" | "md" | "lg";
  hover?: boolean;
  className?: string;
}

export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  className,
  ...props
}: CardProps) {
  const paddings = {
    none: "",
    xs: "p-3",
    sm: "p-4",
    md: "p-5",
    lg: "p-6",
  };

  return (
    <div
      className={cn(
        "bg-surface",
        "border border-border",
        "rounded-card",
        hover &&
          "hover:border-text-muted/30 hover:bg-surface-2/40 transition-colors cursor-pointer",
        paddings[padding],
        className
      )}
      {...props}
    >
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            {icon && (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-text-muted">
                <span className="material-symbols-outlined text-[18px]">{icon}</span>
              </div>
            )}
            <div className="min-w-0">
              {title && <h3 className="text-sm font-semibold text-text-main">{title}</h3>}
              {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

// Sub-component: Bordered section inside Card
Card.Section = function CardSection({ children, className, ...props }: CardSectionProps) {
  return (
    <div
      className={cn("p-4 rounded-control", "bg-surface-2/50", "border border-border", className)}
      {...props}
    >
      {children}
    </div>
  );
};

interface CardRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

// Sub-component: Hoverable row inside Card
Card.Row = function CardRow({ children, className, ...props }: CardRowProps) {
  return (
    <div
      className={cn(
        "p-3 -mx-3 px-3 transition-colors",
        "border-b border-border last:border-b-0",
        "hover:bg-surface-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

interface CardListItemProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  actions?: React.ReactNode;
}

// Sub-component: List item with hover actions (macOS style)
Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}: CardListItemProps) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between p-3 -mx-3 px-3",
        "border-b border-border last:border-b-0",
        "hover:bg-surface-2",
        "transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
