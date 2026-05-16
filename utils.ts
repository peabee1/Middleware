import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui-style class-name merger. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
