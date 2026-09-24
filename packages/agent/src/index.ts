/**
 * Agent core: persistent memory, accumulated skills, tool calling.
 *
 * Structure and storage are real; the learning loop and the Google
 * integrations are deliberately not. See the TODO blocks in
 * skills/registry.ts, memory/summarize.ts, and tools/google/scopes.ts.
 */

export * from './memory/types.js';
export { PostgresMemoryStore } from './memory/store.js';
export {
  collectExchanges,
  type CollectedExchanges,
  type ExchangeCollectorDeps,
} from './memory/summarize.js';
export { capProfile, type ProfileStore } from './memory/profile.js';
export { PostgresProfileStore } from './memory/profile-store.js';

export type { PlanStatus, PlanStep, AgentPlan, PlanStore } from './plan/types.js';
export { PostgresPlanStore, InMemoryPlanStore } from './plan/store.js';
export { validatePlan, renderPlan, PLAN_STALE_AFTER_TURNS } from './plan/render.js';

export { UNTRUSTED_RULE, untrustedNote } from './untrusted.js';
export { Vault, type VaultNote, type NoteKind, type NoteSource } from './vault/vault.js';
export {
  UPLOAD_LIMIT_BYTES,
  importUpload,
  type UploadDeps,
  type UploadRefusal,
  type UploadResult,
} from './vault/upload.js';
export { extractOfficeText, officeKindFor, type OfficeKind } from './vault/office.js';
export { imageExtension, imagePath } from './vault/upload.js';
export { describeImage, isReadableImage } from './vault/image-doc.js';
export { renderNotes } from './vault/render.js';
export { buildGraph, type VaultGraph, type GraphNode } from './vault/graph.js';
export { absorptions, collapse, isNumbered, type Absorption } from './vault/collapse.js';
export { searchVault } from './tools/vault.js';
export { openVaultDocument } from './tools/documents.js';
export { loadSkill } from './tools/skills.js';
export { writeVaultNote } from './tools/vault-write.js';
export { updatePlan } from './tools/plan.js';
export {
  readDocument,
  writeDocument,
  listDocuments,
  capDocument,
  classDocName,
  personDocName,
  PERSON_PREFIX,
  USER_DOC_NAME,
  SCHOOL_DOC_NAME,
  CHATS_DOC_NAME,
  CLASS_PREFIX,
  CLASS_DOC_LIMIT,
  CHATS_DOC_LIMIT,
  SCHOOL_DOC_LIMIT,
} from './vault/documents.js';
export { importConversation } from './vault/conversation.js';
export { slugForNote } from './vault/slug.js';
export { importClassroom, type ClassroomSnapshot, type ImportResult } from './vault/classroom.js';
export { collectClassroomSnapshot, type Collected } from './vault/collect.js';
export {
  importMail,
  classroomEpisode,
  type SchoolMessage,
  type MailImportResult,
} from './vault/mail.js';
export { readFileContents, type FileReadResult } from './vault/files.js';
export { textFromDriveRead } from './vault/drive-text.js';
export {
  importDrive,
  removeDriveFiles,
  courseTitles,
  KEPT_LOOSE,
  type DriveFile,
  type DriveImportResult,
  type DriveVerdict,
} from './vault/drive.js';
export {
  judgeDriveFiles,
  readLedger as readDriveLedger,
  rememberDriveFilesOut,
  standingOf,
  knownFiles,
  driveKind,
  yearBeforeStart,
  type DriveLedger,
  type DriveStanding,
} from './vault/drive-triage.js';
export { readUserDoc, writeUserDoc, USER_DOC_LIMIT } from './vault/user-doc.js';
export { writeClassDocs, type ClassDocResult } from './vault/class-doc.js';
export { writePersonDocs, type PersonDocResult } from './vault/person-doc.js';
export { writeSchoolDoc, academicYearEnd, type SchoolDocResult } from './vault/school-doc.js';
export {
  updateChatsDoc,
  ensureChatsDoc,
  forgetChatInChatsDoc,
  NOTHING_KEPT_YET,
} from './vault/chats-doc.js';
export { readGrade, type GradeReading } from './vault/grade.js';
export { classroomCourse, classroomEvent } from './vault/mail.js';
export {
  classifyCourses,
  describeCourses,
  describeOrphanCourses,
  filterSnapshot,
  lastActivityByCourse,
  academicYearStart,
  FALLBACK_YEAR_END,
  sweepDroppedCourses,
  sweepCourseMail,
  sweepUnattachedFiles,
  courseFingerprint,
  recallCourseVerdicts,
  rememberCourseVerdicts,
  lastCourseVerdicts,
  type CourseVerdict,
} from './vault/courses.js';
export {
  collectDriveFiles,
  collectDriveChanges,
  type DriveChanges,
} from './vault/collect-drive.js';
export {
  collectSchoolMail,
  discoverSchoolDomains,
  domainOf,
  type CollectedMail,
} from './vault/collect-mail.js';
export { schoolDomains } from './vault/mail-query.js';

export * from './skills/types.js';
export { PostgresSkillRegistry } from './skills/registry.js';

export * from './tools/types.js';
export { ToolRegistry } from './tools/registry.js';
export { buildToolRegistry } from './tools/builtin.js';
export {
  listCoursework,
  listCourses,
  listCourseMaterials,
  listAnnouncements,
  listSubmissions,
  listTopics,
  turnInAssignment,
  unsubmitAssignment,
  attachToSubmission,
  type Assignment,
  type Attachment,
  type CourseMaterial,
  type Announcement,
  type SubmissionSummary,
  type Topic,
} from './tools/google/classroom.js';
export {
  readDriveFile,
  listDriveFiles,
  listAccessibleFiles,
  startPageToken,
  watchChanges,
  stopChannel,
  listChanges,
} from './tools/google/drive.js';
// Exported so a caller outside the package can tell a scope refusal from a
// real answer, which is the whole shape the Google tools return.
export { isUnavailable } from './tools/google/client.js';
export {
  searchMail,
  readMail,
  watchMailbox,
  readMailAttachment,
  listMailLabels,
  sendMail,
  modifyMail,
  trashMail,
  type MailAttachment,
} from './tools/google/gmail.js';
export { readSchoolPortal, refreshSchoolPortal, condense } from './tools/portal.js';
export { browseWithAgent, actInBrowser, renderElements } from './tools/browser.js';
export { readWebLink } from './tools/web/read-link.js';
export {
  readYoutubeVideo,
  parseVideoId,
  type YoutubeMetadataSource,
  type YoutubeTranscriptSource,
  type TranscriptOutcome,
  type YoutubeVideo,
} from './tools/web/youtube.js';
export { ocrImage, ocrPdf, describeOcrFailure, type OcrResult } from './tools/ocr.js';
export {
  transcribeMedia,
  describeTranscriptionFailure,
  type AudioTranscriber,
  type TranscriptionResult,
} from './tools/transcribe.js';
export {
  fetchPage,
  htmlToText,
  FetchRejected,
  isForbiddenAddress,
  resolvePublicAddress,
  pinnedLookup,
} from './tools/web/fetch.js';
export type { IntegrationKey } from './tools/builtin.js';
export * from './tools/google/scopes.js';

export * from './transcript/types.js';
export { PostgresTranscriptStore } from './transcript/store.js';
export { InMemoryTranscriptStore } from './transcript/in-memory.js';
export { bootstrapItems, BOOTSTRAP_MESSAGE_LIMIT } from './transcript/bootstrap.js';
export { renderTranscript, renderUserItem, estimateTranscriptTokens } from './transcript/render.js';
export { truncateToolResult } from './transcript/truncate.js';

export {
  runAgentTurn,
  currentTimeSection,
  SIGN_IN_SECTION,
  type AgentRunDeps,
  type AgentRunInput,
  type AgentRunResult,
} from './run.js';
export { nameConversation, tidyTitle, TITLE_LIMIT } from './title.js';

export {
  INLINE_LIMIT_TOKENS,
  estimateTextTokens,
  projectDiff,
  renderProjectBlock,
  type BlockProject,
  type BlockSource,
} from './projects/block.js';
export { SUMMARY_LIMIT, summariseSource } from './projects/summary.js';
export {
  isUntrusted,
  projectVault,
  removeProjectVault,
  sourceKindFor,
  sourceKindForNote,
} from './projects/vault.js';
export { PROJECT_TOOLS, addToProject, openProjectItem, searchProject } from './tools/project.js';
export type { ProjectAccess, ProjectItem, ProjectRef } from './tools/types.js';
