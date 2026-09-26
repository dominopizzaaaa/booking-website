export type Status = 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED';
export type AccountType = 'STUDENT' | 'COACH' | 'CLUB';
/** New commerce belongs to clubs; SOLO remains only as a historical wire value. */
export type BusinessKind = 'CLUB' | 'SOLO';
export type Business = { id: string; name: string; slug: string; ownerName: string; email: string; timezone: string; currency: string; color: string; tagline: string; cancellationHours: number; kind: BusinessKind; isDemo: boolean; legacyReadOnly?: boolean };
/** username and sports are optional only while old fixtures or servers roll forward. */
export type AccountUser = { id: string; name: string; username?: string; email: string; accountType: AccountType; sports?: string[]; phone?: string; parentName?: string };
export type WorkspaceUser = AccountUser & { instructorId: string | null };
/** A membership is an affiliation; permissions come from the account and business kinds. */
export type Membership = { id: string; userId: string; businessId: string; instructorId: string | null; active: boolean; createdAt: string; business: Business };
export type AuthSession = { user: AccountUser; membership: Membership | null; business: Business | null; memberships: Membership[] };
export type Instructor = { id: string; name: string; initials: string; color: string; email: string; specialty: string; rescheduleNoticeHours: number; active: boolean };
export type WorkspaceInstructor = Instructor & { accountLinkAvailable: boolean };
export type Location = { id: string; name: string; address: string; type: 'FACILITY' | 'RENTED' | 'HOME' | 'ONLINE'; color: string; requiresApproval: boolean; travelMinutes: number; notes: string; source: VenueSource; placeId: string; mapsUrl: string; latitude: number | null; longitude: number | null; active: boolean };
export type VenueSource = 'MANUAL' | 'GOOGLE_MAPS';
export type VenueCandidate = { placeId: string; name: string; address: string; mapsUrl: string; latitude: number | null; longitude: number | null; source: VenueSource };
export type VenueSearchResult = { configured: boolean; results: VenueCandidate[] };
export type CalendarProvider = 'GOOGLE';
export type CalendarConnectionState = 'DISCONNECTED' | 'ACTIVE' | 'REAUTH_REQUIRED' | 'ERROR' | 'DISCONNECTING';
export type CalendarPreferences = { syncEnabled: boolean; busyCheckEnabled: boolean };
export type CalendarReturnTo = '/account' | '/?tab=profile' | '/manage?tab=profile';
export type CalendarConnectionStatus = {
  configured: boolean; eligible: boolean; provider: CalendarProvider | null;
  state: CalendarConnectionState; connected: boolean; email: string | null; calendarName: string | null;
  syncEnabled: boolean; busyCheckEnabled: boolean; connectedAt: string | null;
  lastSyncedAt: string | null; lastBusyAt: string | null; busyCacheExpiresAt: string | null; error: string | null;
};
export type PublicInstructor = Pick<Instructor, 'id' | 'name' | 'initials' | 'color' | 'specialty' | 'active'>;
export type PublicLocation = Pick<Location, 'id' | 'name' | 'address' | 'type' | 'color' | 'requiresApproval' | 'active'> & { mapsUrl?: string };
export type PublicBookingBusiness = Pick<Business, 'name' | 'slug' | 'ownerName' | 'timezone' | 'currency' | 'color' | 'tagline' | 'cancellationHours'> & { kind?: BusinessKind };
export type ServiceLocation = { locationId: string; price: number; duration: number; instructorIds: string[] };
export type Service = { id: string; name: string; description: string; category: string; type: 'PRIVATE' | 'GROUP'; duration: number; price: number; capacity: number; bufferMinutes: number; noticeHours: number; color: string; active: boolean; locations: ServiceLocation[] };
export type CoachScopedServiceLocation = Omit<ServiceLocation, 'price'>;
export type CoachScopedService = Omit<Service, 'price' | 'locations'> & { locations: CoachScopedServiceLocation[] };
export type Availability = { id: string; instructorId: string; locationId: string; dayOfWeek: number; startTime: string; endTime: string };
export type AvailabilityException = { id: string; instructorId: string; date: string; reason: string };
export type Student = { id: string; userId: string | null; name: string; email: string; phone: string; initials: string; notes: string; parentName: string; createdAt: string; bookingCount: number; lastBookingAt: string | null };
export type LessonPackage = {
  id: string; studentId: string; studentName: string; name: string; serviceId: string | null;
  /** Optional only while older workspace payloads roll forward. */
  serviceIds?: string[]; rentalLocationIds?: string[];
  totalCredits: number; usedCredits: number; price: number; expiresAt: string; paid: boolean;
};
export type Participant = { id: string; studentId: string; name: string; email: string; attendance: 'UNMARKED' | 'PRESENT' | 'ABSENT'; paid: boolean; price: number; packageId: string | null; notes: string; cancelled?: boolean; cancelledAt?: string | null };
export type CoachScopedParticipant = Omit<Participant, 'paid' | 'price' | 'packageId'>;
/** "CLUB" runs the money through the club's books; "DIRECT" goes to the coach. */
export type PaymentRoute = 'CLUB' | 'DIRECT';
export type CoachAcceptance = 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' | 'DECLINED';
export type Booking = { id: string; serviceId: string; serviceName: string; instructorId: string; instructorName: string; locationId: string; locationName: string; locationColor: string; startAt: string; endAt: string; status: Status; type: 'PRIVATE' | 'GROUP'; capacity: number; price: number; paymentRoute: PaymentRoute; coachAcceptance: CoachAcceptance; createdByRole: AccountType; notes?: string; address: string; recurringId: string | null; participants: Participant[] };
export type CoachScopedBooking = Omit<Booking, 'price' | 'participants'> & { participants: CoachScopedParticipant[] };

export type RescheduleStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';
export type RescheduleRequest = {
  id: string; bookingId: string; participantId: string | null;
  requestedByRole: AccountType; requestedByUserId: string | null;
  proposedStartAt: string; proposedEndAt: string; originalStartAt: string;
  message: string; status: RescheduleStatus; respondedAt: string | null; responseMessage: string;
  createdAt: string; serviceName: string; instructorName: string; locationName: string;
  businessName: string; timezone: string;
};

export type IntegrityFlag = {
  id: string; instructorId: string | null; coachName: string; studentName: string;
  type: string; status: 'OPEN' | 'REVIEWING' | 'DISMISSED' | 'UPHELD';
  detail: string; occurrences: number; outsideBusinessName: string;
  firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null; resolutionNote: string;
  flaggedSessionAt: string | null; flaggedServiceName: string | null;
};
export type PaymentKind = 'STUDENT_TO_CLUB' | 'STUDENT_TO_COACH' | 'CLUB_TO_COACH';
type PaymentBase = { id: string; bookingId: string | null; packageId: string | null; amount: number; method: 'CASH' | 'BANK_TRANSFER' | 'SIMULATED_STRIPE' | 'OTHER'; note: string; paidAt: string; reversedAt: string | null; reversedReason: string };
export type Payment = PaymentBase & (
  | { kind: 'STUDENT_TO_CLUB' | 'STUDENT_TO_COACH'; studentId: string; studentName: string; instructorId: null; instructorName: null }
  | { kind: 'CLUB_TO_COACH'; studentId: null; studentName: null; instructorId: string; instructorName: string }
);
/** Shared alert vocabulary; see backend/src/notifications.ts. */
export type NotificationType = 'BOOKING' | 'PAYMENT' | 'PAYOUT' | 'RESCHEDULE' | 'CANCELLATION' | 'PENDING_ACTION' | 'INTEGRITY' | 'ATTENDANCE' | 'NOTICE';
export type Notification = { id: string; type: NotificationType; bookingId: string | null; integrityFlagId: string | null; title: string; message: string; read: boolean; actionNeeded: boolean; createdAt: string };
type WorkspaceCollections<TService extends Service | CoachScopedService, TBooking extends Booking | CoachScopedBooking> = { business: Business; user: WorkspaceUser; membership: Membership; memberships: Membership[]; clubAccount: boolean; instructors: WorkspaceInstructor[]; locations: Location[]; services: TService[]; availability: Availability[]; exceptions: AvailabilityException[]; students: Student[]; packages: LessonPackage[]; bookings: TBooking[]; payments: Payment[]; notifications: Notification[]; rescheduleRequests: RescheduleRequest[]; integrityFlags: IntegrityFlag[] };
export type FullWorkspace = WorkspaceCollections<Service, Booking>;
export type ClubWorkspace = FullWorkspace & { business: Business & { kind: 'CLUB' }; user: WorkspaceUser & { accountType: 'CLUB' }; clubAccount: true };
/** Historical wire shape only. Legacy solo practices can still appear during a rolling deploy, but the current UI must not open them. */
export type SoloWorkspace = FullWorkspace & { business: Business & { kind: 'SOLO' }; user: WorkspaceUser & { accountType: 'COACH' }; clubAccount: false };
export type ManagerWorkspace = ClubWorkspace;
export type CoachClubWorkspace = Omit<WorkspaceCollections<CoachScopedService, CoachScopedBooking>, 'packages' | 'payments' | 'integrityFlags'> & { business: Business & { kind: 'CLUB' }; user: WorkspaceUser & { accountType: 'COACH' }; clubAccount: false; packages: never[]; payments: never[]; integrityFlags: never[] };
export type WorkspaceResponse = ManagerWorkspace | CoachClubWorkspace;
/** Accept this only at the API boundary while an older server may still return a removed SOLO workspace. */
export type WorkspaceWireResponse = WorkspaceResponse | SoloWorkspace;
export type WorkspaceBooking = WorkspaceResponse['bookings'][number];
export type WorkspaceService = WorkspaceResponse['services'][number];

export function isCoachClubWorkspace(workspace: WorkspaceWireResponse): workspace is CoachClubWorkspace {
  return workspace.user.accountType === 'COACH' && workspace.business.kind === 'CLUB';
}
export function isWorkspaceResponse(workspace: WorkspaceWireResponse): workspace is WorkspaceResponse {
  return workspace.business.kind === 'CLUB' && !workspace.business.legacyReadOnly
    && (workspace.user.accountType === 'CLUB' || workspace.user.accountType === 'COACH');
}
export function isManagerWorkspace(workspace: WorkspaceWireResponse): workspace is ManagerWorkspace {
  return workspace.user.accountType === 'CLUB'
    && workspace.business.kind === 'CLUB'
    && !workspace.business.legacyReadOnly;
}
export type Slot = { startAt: string; endAt: string; available: boolean; placesRemaining: number; reason?: string };
export type PublicBusiness = { business: PublicBookingBusiness; instructors: PublicInstructor[]; locations: PublicLocation[]; services: Service[] };
export type BookingInput = { serviceId: string; instructorId?: string; locationId: string; startAt: string; studentId: string; repeatWeeks?: number; packageId?: string; notes?: string; address?: string };
export type PublicBookingInput = { serviceId: string; instructorId: string; locationId: string; startAt: string; student?: { phone?: string; parentName?: string }; repeatWeeks?: number; packageId?: string; notes?: string; address?: string };
export type BookingResult = { bookings: Booking[]; conflicts?: { date: string; reason: string }[] };
export type ProviderBookingResult = { bookings: WorkspaceBooking[]; conflicts?: { date: string; reason: string }[] };
export type AccountBooking = {
  business: PublicBookingBusiness; booking: Booking; participant: Participant; location?: PublicLocation;
  canCancel?: boolean; canReschedule?: boolean;
  rescheduleRequest?: RescheduleRequest | null;
  awaitingCoach?: boolean;
  paymentRoute?: PaymentRoute;
  management?: { cancellationHours: number; rescheduleNoticeHours?: number; reminders?: string; venueReserved?: boolean };
};
export type AccountBookingsResult = { bookings: AccountBooking[] };
export type StudentClubDirectoryEntry = {
  business: PublicBookingBusiness & { kind: 'CLUB' };
  sports: string[];
  serviceCount: number;
  coachCount: number;
  locationCount: number;
  priceFrom: number;
};
export type StudentClubDirectoryResult = { clubs: StudentClubDirectoryEntry[] };
export type StudentClubDirectoryPage = StudentClubDirectoryResult & { nextCursor?: string | null };

export type NamedMarketplaceItem = { id: string; name: string };
export type PackageOfferBusiness = { name: string; slug: string; currency: string };
export type PackageOffer = {
  id: string; businessId: string; name: string; description: string; price: number; totalCredits: number;
  validityDays: number; active: boolean; createdAt: string; updatedAt: string; business?: PackageOfferBusiness;
  archivedAt?: string | null;
  serviceIds: string[]; rentalLocationIds: string[];
  services: NamedMarketplaceItem[]; rentalLocations: NamedMarketplaceItem[];
};
export type PackageOfferInput = {
  name: string; description?: string; price: number; totalCredits: number; validityDays: number; active?: boolean;
  serviceIds: string[]; rentalLocationIds: string[];
};
export type AccountPackageState = 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'UNPAID';
export type AccountPackage = {
  id: string; businessId: string; offerId: string | null; name: string; totalCredits: number; usedCredits: number;
  remainingCredits: number; price: number; expiresAt: string; paid: boolean; state: AccountPackageState;
  business: PackageOfferBusiness & { id?: string }; offer: NamedMarketplaceItem | null; serviceId: string | null;
  serviceIds: string[]; rentalLocationIds: string[]; services: NamedMarketplaceItem[]; rentalLocations: NamedMarketplaceItem[];
  serviceNames?: string[]; rentalLocationNames?: string[];
};
export type SimulatedPaymentOutcome = 'SUCCEEDED' | 'FAILED';
export type PaymentIntentStatus = 'REQUIRES_CONFIRMATION' | SimulatedPaymentOutcome | 'CANCELLED' | 'REFUNDED';
export type CheckoutInput = { idempotencyKey: string; simulatedOutcome: SimulatedPaymentOutcome };
export type PaymentIntent = {
  id: string; kind?: 'PACKAGE' | 'BOOKING' | 'RENTAL'; amount: number; currency: string; status: PaymentIntentStatus;
  provider?: string; providerReference?: string; idempotencyKey?: string; failureCode?: string | null;
  packageOfferId?: string | null; packageId?: string | null; participantId?: string | null; reservationId?: string | null; createdAt: string; updatedAt?: string;
  confirmedAt?: string | null; failedAt?: string | null;
};
export type CheckoutParticipant = { id: string; bookingId: string; paid: boolean };
export type CheckoutResult = { paymentIntent: PaymentIntent; package: AccountPackage | null; participant: CheckoutParticipant | null };

export type RentalListing = {
  id: string; locationId: string; name: string; address: string; sport: string; amenities: string[]; unitLabel: string;
  price: number; currency: string; timezone: string; club: { name: string; slug: string };
};
export type RentalUnit = { id: string; name: string; active: boolean };
export type RentalOpeningHours = { dayOfWeek: number; startTime: string; endTime: string };
export type RentalDetail = RentalListing & {
  enabled: boolean; minDuration: number; maxDuration: number; startInterval: number; durationIncrement: number;
  noticeHours: number; advanceDays: number; cancellationHours: number; rules: string;
  units: RentalUnit[]; openingHours: RentalOpeningHours[];
};
export type RentalSlot = { unitId: string; unitName: string; startAt: string; endAt: string; price: number };
export type RentalSlotsResult = { date: string; duration: number; timezone: string; slots: RentalSlot[] };
export type RentalReservationStatus = 'CONFIRMED' | 'PENDING' | 'CANCELLED';
export type RentalPaymentStatus = 'UNPAID' | 'PAID' | 'PACKAGE' | 'REFUNDED';
export type RentalReservation = {
  id: string; businessName: string; locationId: string; locationName: string; unitId: string; unitName: string;
  startAt: string; endAt: string; duration: number; price: number; status: RentalReservationStatus;
  paymentStatus: RentalPaymentStatus; packageId: string | null; creditConsumed: boolean; currency: string; timezone: string;
  cancellationDeadline: string; cancellable: boolean;
};
export type RentalReservationInput = {
  unitId: string; startAt: string; duration: number; idempotencyKey: string;
  simulatedOutcome: SimulatedPaymentOutcome; packageId?: string;
};
export type RentalReservationResult =
  | { reservation: RentalReservation; paymentIntent: PaymentIntent & { status: 'SUCCEEDED' | 'REFUNDED' } }
  | { reservation: null; paymentIntent: PaymentIntent & { status: 'FAILED' } };
export type RentalConfigValues = {
  sport: string; rules: string; amenities: string[]; unitLabel: string; price: number;
  startInterval: number; minDuration: number; durationIncrement: number; maxDuration: number; noticeHours: number;
  advanceDays: number; cancellationHours: number;
  units: Array<{ id?: string; name: string; active?: boolean }>; openingHours: RentalOpeningHours[];
};
export type RentalConfigInput = RentalConfigValues & { locationId: string };
export type RentalConfigUpdate = Partial<RentalConfigValues>;
export type RentalLocationCoreInput = Omit<Location, 'id'>;
export type RentalLocationSaveInput = {
  mode: 'CREATE' | 'UPDATE'; location: RentalLocationCoreInput;
  rental: { enabled: false } | ({ enabled: true } & RentalConfigValues);
};
export type RentalLocationSaveResult = { location: Location; rental: RentalDetail; replay: boolean };
export type AccountDirectoryUser = Pick<AccountUser, 'name' | 'accountType'> & { username: string; sports: string[] };

/** Session chat. Membership is derived from the booking on the server. */
export type ChatRole = 'STUDENT' | 'COACH' | 'CLUB';
export type ChatViewerRole = ChatRole | 'ADMIN';
export type ChatMember = { role: ChatRole; name: string; isYou: boolean };
export type ChatSession = {
  bookingId: string; serviceId: string; instructorId: string; locationId: string;
  serviceName: string; type: 'PRIVATE' | 'GROUP'; status: Status; startAt: string; endAt: string;
  locationName: string; instructorName: string; businessName: string; businessSlug: string; timezone: string;
};
export type SessionProposalStatus = 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'COUNTERED' | 'WITHDRAWN' | 'CLOSED' | 'EXPIRED';
export type SessionProposalResponse = {
  studentName: string; status: 'ACCEPTED' | 'DECLINED' | 'COUNTERED';
  forYou: boolean; byYou: boolean; bookingId: string | null; createdAt: string;
};
export type SessionProposal = {
  id: string; status: SessionProposalStatus; startAt: string; endAt: string; timezone: string;
  serviceName: string; locationName: string; instructorName: string;
  proposedByRole: 'STUDENT' | 'COACH'; proposedByName: string; proposedByYou: boolean;
  /** Null when a coach asked a whole group; each student answers for themselves. */
  forName: string | null; forYou: boolean; isCounter: boolean; message: string; createdAt: string;
  awaiting: string[]; responses: SessionProposalResponse[];
  actions: { accept: boolean; decline: boolean; counter: boolean; withdraw: boolean };
};
export type ChatMessage = {
  id: string; kind: 'TEXT' | 'SYSTEM' | 'PROPOSAL'; event: string | null; senderRole: ChatRole | 'SYSTEM';
  senderName: string; body: string; createdAt: string; mine: boolean; proposalId: string | null;
  proposal?: SessionProposal | null;
};
export type ChatThreadSummary = {
  id: string; bookingId: string; lastMessageAt: string; session: ChatSession; members: ChatMember[];
  lastMessage: ChatMessage | null; unreadCount: number;
  /** Present only in the platform admin listing. */
  messageCount?: number;
};
export type ChatThreadList = { threads: ChatThreadSummary[]; nextCursor: string | null; unreadThreads?: number };
export type ChatThreadDetail = {
  id: string; bookingId: string; lastMessageAt: string; session: ChatSession; members: ChatMember[];
  viewer: { role: ChatViewerRole; canPost: boolean; canPropose: boolean };
  messages: ChatMessage[]; hasEarlier: boolean;
};
export type ChatProposalAction = 'accept' | 'decline' | 'withdraw';
