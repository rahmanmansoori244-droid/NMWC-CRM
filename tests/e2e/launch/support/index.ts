/**
 * The launch e2e support surface. Spec files import from here only.
 * See tests/e2e/launch/README.md.
 */
export {
  BASE_URL,
  PORT,
  RUN_ID,
  SERVER_MODE,
  SESSION_COOKIE,
  assertNotProduction,
  db,
  disconnectDb,
  hasR2,
  launchEnabled,
  ownerDb,
  redact,
  safeError,
} from './env';
export {
  OMAN_TODAY,
  RUN_OMAN_DATE,
  assertOmanDayUnchanged,
  clockGuard,
  omanDateISO,
  omanDayAfter,
  omanDayOfWeek,
  omanFmt,
  omanYearNow,
  slaDeadline,
  utcDateBehindOman,
  utcYmd,
  workingMinutesAgo,
  workingMinutesBetween,
} from './oman';
export { requireLaunchEnv, installLaunchHooks } from './guard';
export { LAUNCH_FINAL, NOT_RUN_ON_UAT, notRunHere } from './not-run';
export {
  IN_PLACE_MS,
  NAV_HANG,
  SERVER_WORK_MS,
  landsInPlace,
  requestsOf,
  shownInPlace,
  trackRequests,
  type RequestLog,
  type ServerDone,
} from './in-place';
export { INITIAL_PASSWORD, MUSCAT, createWorld, standardWorld } from './world';
export type {
  BranchSpec,
  CustomerSpec,
  DeviceKind,
  FixtureBranch,
  FixtureCustomer,
  FixtureRegion,
  FixtureRoute,
  FixtureUser,
  SeededPhoto,
  UserSpec,
  World,
  WorldSpec,
} from './types';
export {
  HOME_BY_ROLE,
  MUSCAT_GEO,
  apiSignIn,
  changePasswordViaUi,
  clearSecretFields,
  closeTestContexts,
  contextAs,
  deviceOptions,
  drainLimit,
  fetchAs,
  fillSecret,
  homePathFor,
  mintSessionCookie,
  mintingProven,
  projectDevice,
  resetLimits,
  signInViaUi,
} from './sessions';
export { approvalPlanFor, seedNotification, seedPhoto, seedPhotos, seedUpdateEdit, type FieldChange, type PhotoSpec, type UpdatePatch } from './seeds';
export {
  KNOWN_BUGS,
  auditFor,
  expectCleanConsole,
  expectNoDataLeak,
  expectNoRegionNotice,
  expectNoSideScroll,
  freshGoto,
  hitTest,
  mutePage,
  noRegionNotice,
  notificationsFor,
  reloadUntil,
  snapshot,
  watchPage,
  type KnownBugId,
  type SnapshotTable,
} from './checks';
export { fakeHeic, jpegInBrowser, png, sha256Hex, textFile, tinyJpeg, tinyPdf, uniquePng } from './media';
export {
  closeBranchViaApi,
  postForm,
  postJson,
  receiptEditId,
  requestReactivationViaApi,
  submitCreateViaApi,
  submitEnrichViaApi,
  uploadPhotoViaApi,
  type ActionJson,
  type EditPatch,
  type UploadedPhoto,
} from './api';
export { actionIdFor, captureServerAction, replayServerAction, type CapturedAction, type ReplayResult } from './actions';
export { assertFixtureKey, listFixturePrefix, r2BucketName } from './r2';
export { cleanupRegistry, residue, sweepRun, sweepStale, totalOf, type CleanupResult, type Residue } from './cleanup';
export { newId } from './ids';
export {
  TEMIX_CODE_BULK_REFUSED_MESSAGE,
  TEMIX_CODE_CRM_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  TEMIX_LOCK_LABEL,
  TEMIX_LOCK_NOTE,
  normalizeTemixCode,
  temixCodeBox,
  temixCodeFor,
  temixCodeHolderMessage,
  temixCodeTakenMessage,
  typeTemixCode,
} from './temix-codes';
export { FIXTURE_PASSWORD_SHAPE, describeHit, launchArtifactRoots, scanForSecrets, type ScanResult, type SecretHit } from './secret-scan';
