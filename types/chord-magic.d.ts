// chord-magic.d.ts
declare module 'chord-magic' {
    export function parse(chord: string, options?: any): any;
    export function transpose(chord: any, step: number): any;
    export function prettyPrint(chord: any, options?: { naming?: string[] }): string;
  }