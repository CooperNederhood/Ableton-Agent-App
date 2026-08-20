export const yoloCommandUsage = "/yolo [on|off] [all]";

export interface YoloCommand {
  enabled: boolean;
  all: boolean;
}

export function parseYoloCommand(input: string): YoloCommand | undefined {
  if (!/^\/yolo(?:\s|$)/iu.test(input)) return undefined;

  switch (input) {
    case "/yolo":
    case "/yolo on":
      return { enabled: true, all: false };
    case "/yolo off":
      return { enabled: false, all: false };
    case "/yolo on all":
      return { enabled: true, all: true };
    case "/yolo off all":
      return { enabled: false, all: true };
    default:
      throw new Error(`Invalid /yolo command. Usage: ${yoloCommandUsage}.`);
  }
}
