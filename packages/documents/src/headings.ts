import type { ResumeSectionKind } from "@vervecv/evaluation";

const EXACT_HEADINGS: Record<string, ResumeSectionKind> = {
  "professional summary": "PROFESSIONAL_SUMMARY",
  summary: "PROFESSIONAL_SUMMARY",
  profile: "PROFESSIONAL_SUMMARY",
  objective: "PROFESSIONAL_SUMMARY",
  "work experience": "WORK_EXPERIENCE",
  "professional experience": "WORK_EXPERIENCE",
  employment: "WORK_EXPERIENCE",
  experience: "WORK_EXPERIENCE",
  "leadership experience": "LEADERSHIP_EXPERIENCE",
  leadership: "LEADERSHIP_EXPERIENCE",
  projects: "PROJECTS",
  "personal projects": "PROJECTS",
  education: "EDUCATION",
  skills: "SKILLS",
  "technical skills": "SKILLS",
  certifications: "CERTIFICATIONS",
  certificates: "CERTIFICATIONS",
  contact: "CONTACT",
  "contact information": "CONTACT",
};

/** Classifies a block only when its whole text is a known heading. Other headings stay unclassified. */
export function classifyHeading(text: string): ResumeSectionKind | null {
  const normalized = text.trim().replace(/[:\s]+$/u, "").replace(/\s+/gu, " ").toLowerCase();
  if (normalized.length === 0 || normalized.length > 80) {
    return null;
  }
  return EXACT_HEADINGS[normalized] ?? null;
}
