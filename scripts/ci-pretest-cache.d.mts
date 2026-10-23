export const PRETEST_MARKER_VERSION: number;

export function computePretestHash(pkgDir: string, repoRoot: string): string;
export function readPretestMarker(pkgDir: string): { v: number; hash: string } | null;
export function writePretestMarker(pkgDir: string, hash: string): void;
export function pretestBuildIsFresh(pkgDir: string, expectedHash: string): boolean;
export function ensurePretestBuild(
    pkgName: string,
    opts?: { root?: string },
): { built: boolean; hash: string };
