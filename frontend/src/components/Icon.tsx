interface IconProps {
  name: "copy" | "swap" | "trash" | "x" | "wand" | "pencil";
  size?: number;
  title?: string;
}

export function Icon({ name, size = 16, title }: IconProps): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "swap":
      return (
        <svg {...common}>
          <path d="M7 4v13m0 0-3-3m3 3 3-3" />
          <path d="M17 20V7m0 0 3 3m-3-3-3 3" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "wand":
      return (
        <svg {...common}>
          <path d="m3 21 9-9" />
          <path d="M12.5 6.5 17 2l5 5-4.5 4.5" />
          <path d="m9.5 9.5 1.5-1.5" />
          <path d="m14.5 14.5 1.5-1.5" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...common}>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      );
  }
  return <span title={title} />;
}
