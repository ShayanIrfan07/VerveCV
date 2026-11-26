import { averageRoleCompletion, minimumBulletsScore, roleEntryCredit, type BandScore } from "./bands.js";
import { extractionArtifactIds } from "./detectors.js";
import { parseEntries, type ParsedEntry } from "./entries.js";
import type { ResumeBlock, ResumeDocument, ResumeSectionKind } from "./model.js";

/**
 * Employer identity is the normalized header line. No company directory is used.
 * v2 separates a title from the employer on the same line and lets a later
 * title-and-date header reuse the employer line already read for that section.
 */
export const ROLE_MEASUREMENT_VERSION = "roles-2026-11-26-v2";

const TITLE =
  /\b(?:engineer|developer|manager|analyst|consultant|director|designer|scientist|specialist|coordinator|associate|officer|architect|accountant|representative|executive|founder|researcher|intern|president|administrator|marketer|recruiter|head\s+of)\b/iu;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface Duty {
  kind: ResumeSectionKind;
  organization: string | null;
  inheritOrganization: boolean;
  recency: number | null;
  bullets: number;
  blockId: string;
}

export interface RoleMeasurement {
  band: BandScore;
  shortBlockIds: string[];
}

export function measureRoles(document: ResumeDocument): RoleMeasurement | null {
  const parsed = parseEntries(document);
  if (parsed.issues.length > 0) {
    return null;
  }
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const duties = parsed.entries.map((entry) => dutyOf(entry, byId));
  if (duties.some((duty) => duty === null)) {
    return null;
  }
  const ready = duties.filter((duty): duty is Duty => duty !== null);
  const work = resolveEmployers(ready.filter((duty) => duty.kind === "WORK_EXPERIENCE"));
  if (work === null) {
    return null;
  }
  const others = ready.filter((duty) => duty.kind !== "WORK_EXPERIENCE");
  const grouped = groupCompanies(work);
  if (grouped === null) {
    return null;
  }
  const credits: number[] = [];
  const shortBlockIds: string[] = [];
  for (const company of grouped) {
    company.roles.forEach((role, index) => {
      const requirement = requirementFor(grouped.length, company.rank, index);
      const credit = roleEntryCredit(requirement, role.bullets);
      if (credit === null) {
        return;
      }
      credits.push(credit);
      if (credit < 1) {
        shortBlockIds.push(role.blockId);
      }
    });
  }
  for (const duty of others) {
    const credit = roleEntryCredit(1, duty.bullets);
    if (credit === null) {
      return null;
    }
    credits.push(credit);
    if (credit < 1) {
      shortBlockIds.push(duty.blockId);
    }
  }
  const average = averageRoleCompletion(credits);
  if (average === null) {
    return null;
  }
  return { band: minimumBulletsScore(average), shortBlockIds };
}

function dutyOf(entry: ParsedEntry, byId: Map<string, ResumeBlock>): Duty | null {
  const header = entry.headerBlockIds.map((id) => byId.get(id)?.text ?? "").join(" ");
  const bullets = countBullets(entry, byId);
  const firstBullet = entry.bulletBlockIds.find((id) => byId.get(id)?.type === "bullet") ?? entry.bulletBlockIds[0];
  if (firstBullet === undefined) {
    return null;
  }
  if (entry.sectionKind !== "WORK_EXPERIENCE") {
    return { kind: entry.sectionKind, organization: null, inheritOrganization: false, recency: null, bullets, blockId: firstBullet };
  }
  const read = organizationOf(entry.headerBlockIds.map((id) => byId.get(id)?.text ?? ""));
  const recency = recencyOf(header);
  if (read.status === "unknown" || recency === null) {
    return null;
  }
  return {
    kind: entry.sectionKind,
    organization: read.status === "named" ? read.name : null,
    inheritOrganization: read.status === "inherit",
    recency,
    bullets,
    blockId: firstBullet,
  };
}

function resolveEmployers(work: readonly Duty[]): Duty[] | null {
  let previous: string | null = null;
  const resolved: Duty[] = [];
  for (const duty of work) {
    if (duty.organization) {
      previous = duty.organization;
      resolved.push(duty);
      continue;
    }
    if (duty.inheritOrganization && previous) {
      resolved.push({ ...duty, organization: previous });
      continue;
    }
    return null;
  }
  return resolved;
}

function countBullets(entry: ParsedEntry, byId: Map<string, ResumeBlock>): number {
  const blocks = entry.bulletBlockIds
    .map((id) => byId.get(id))
    .filter((block): block is ResumeBlock => block !== undefined && block.type === "bullet");
  const artifacts = extractionArtifactIds(blocks.map((block) => ({ text: block.text, id: block.id, ...(block.paragraphId ? { paragraphId: block.paragraphId } : {}) })));
  return blocks.filter((block) => !artifacts.has(block.id)).length;
}

const TITLE_MODIFIER = "senior|junior|staff|principal|lead|chief|associate|software|product|project|program|data|marketing|sales|finance|operations|research|full[- ]stack|front[- ]end|back[- ]end";
const TITLE_WORD = "engineer|developer|manager|analyst|consultant|director|designer|scientist|specialist|coordinator|associate|officer|architect|accountant|representative|executive|founder|researcher|intern|president|administrator|marketer|recruiter|supervisor|head\\s+of(?:\\s+\\p{L}+)?";
const TITLE_PHRASE = new RegExp(`^(?:(?:${TITLE_MODIFIER})\\s+)*(?:${TITLE_WORD})$`, "iu");
const TITLE_RESIDUE = new RegExp(`^(?:${TITLE_MODIFIER})(?:\\s+(?:${TITLE_MODIFIER}))*$`, "iu");

type OrganizationRead = { status: "named"; name: string } | { status: "inherit" } | { status: "unknown" };

function organizationOf(lines: readonly string[]): OrganizationRead {
  const parts = lines
    .flatMap((line) => line.split(/\s*(?:,|\||—|–| - | at | @ )\s*/iu))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const organizations: string[] = [];
  let sawTitle = false;
  let sawClient = false;
  for (const part of parts) {
    const read = readHeaderPart(part);
    if (read.kind === "client") {
      sawClient = true;
    } else if (read.kind === "title") {
      sawTitle = true;
    } else if (read.kind === "org") {
      organizations.push(normalizeOrganization(read.name));
    }
  }
  const unique = [...new Set(organizations)];
  if (unique.length === 1 && unique[0]) {
    return { status: "named", name: unique[0] };
  }
  if (unique.length === 0 && sawTitle && !sawClient && recencyOf(lines.join(" ")) !== null) {
    return { status: "inherit" };
  }
  return { status: "unknown" };
}

function readHeaderPart(part: string): { kind: "date" } | { kind: "client" } | { kind: "title" } | { kind: "org"; name: string } {
  if (/^(?:client|customer|project)\b/iu.test(part)) {
    return { kind: "client" };
  }
  if (isDateOnly(part)) {
    return { kind: "date" };
  }
  const cleaned = stripDateWords(part);
  if (cleaned.length === 0) {
    return { kind: "date" };
  }
  const trailing = organizationBesideTitle(cleaned, "trailing");
  if (trailing) {
    return { kind: "org", name: trailing };
  }
  const leading = organizationBesideTitle(cleaned, "leading");
  if (leading) {
    return { kind: "org", name: leading };
  }
  if (isTitlePhrase(cleaned)) {
    return { kind: "title" };
  }
  return { kind: "org", name: cleaned };
}

function organizationBesideTitle(value: string, side: "trailing" | "leading"): string | null {
  const words = value.split(/\s+/u).filter((word) => word.length > 0);
  const starts = side === "trailing" ? words.map((_, index) => index).filter((index) => index > 0) : [];
  if (side === "leading") {
    for (let end = words.length - 1; end > 0; end -= 1) {
      const title = words.slice(0, end).join(" ");
      const org = words.slice(end).join(" ");
      if (isTitlePhrase(title) && !isTitleResidue(org) && !isDateOnly(org)) {
        return org;
      }
    }
    return null;
  }
  for (const start of starts) {
    const title = words.slice(start).join(" ");
    const org = words.slice(0, start).join(" ");
    if (isTitlePhrase(title) && !isTitleResidue(org)) {
      return org;
    }
  }
  return null;
}

function isTitlePhrase(value: string): boolean {
  return TITLE_PHRASE.test(value.trim()) || TITLE.test(value);
}

function isTitleResidue(value: string): boolean {
  return isTitlePhrase(value) || TITLE_RESIDUE.test(value.trim());
}

function stripDateWords(value: string): string {
  return value
    .replace(/\b(?:present|current|(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/giu, " ")
    .replace(/[-–—/]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeOrganization(value: string): string {
  return value.toLowerCase().replace(/[.]/gu, "").replace(/\s+/gu, " ").trim();
}

function isDateOnly(line: string): boolean {
  const stripped = line
    .replace(/\b(?:present|current|(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/giu, " ")
    .replace(/[-–—/,]/gu, " ")
    .trim();
  return stripped.length === 0;
}

function recencyOf(header: string): number | null {
  if (/\b(?:present|current)\b/iu.test(header)) {
    return 1_000_000;
  }
  const matches = [...header.matchAll(/\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d{2})\b/giu)];
  const last = matches[matches.length - 1];
  if (!last?.[2]) {
    return null;
  }
  const month = last[1] ? MONTHS[last[1].slice(0, 3).toLowerCase()] ?? 1 : 1;
  return Number(last[2]) * 12 + month;
}

interface CompanyGroup {
  rank: number;
  roles: Array<{ recency: number; bullets: number; blockId: string }>;
}

function groupCompanies(work: readonly Duty[]): CompanyGroup[] | null {
  if (work.some((duty) => duty.organization === null || duty.recency === null)) {
    return null;
  }
  const byOrg = new Map<string, Duty[]>();
  for (const duty of work) {
    const key = duty.organization ?? "";
    byOrg.set(key, [...(byOrg.get(key) ?? []), duty]);
  }
  const companies = [...byOrg.values()].map((roles) => {
    const ordered = [...roles].sort((left, right) => (right.recency ?? 0) - (left.recency ?? 0));
    if (ordered.length > 1 && ordered[0]?.recency === ordered[1]?.recency) {
      return null;
    }
    return {
      recency: ordered[0]?.recency ?? 0,
      roles: ordered.map((role) => ({ recency: role.recency ?? 0, bullets: role.bullets, blockId: role.blockId })),
    };
  });
  if (companies.some((company) => company === null)) {
    return null;
  }
  const ready = companies.filter((company): company is { recency: number; roles: CompanyGroup["roles"] } => company !== null);
  ready.sort((left, right) => right.recency - left.recency);
  if (boundaryTied(ready.map((company) => company.recency))) {
    return null;
  }
  return ready.map((company, rank) => ({ rank, roles: company.roles }));
}

function boundaryTied(recency: readonly number[]): boolean {
  if (recency.length <= 2) {
    return false;
  }
  if (recency.length <= 4) {
    return recency[1] === recency[2];
  }
  return recency[0] === recency[1];
}

function requirementFor(companyCount: number, rank: number, roleIndex: number): 4 | 2 {
  const latestAtCountedCompany = roleIndex === 0 && (companyCount <= 2 || (companyCount <= 4 ? rank < 2 : rank === 0));
  return latestAtCountedCompany ? 4 : 2;
}
