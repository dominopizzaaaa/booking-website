export type Status = 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED';
export type AccountType = 'CUSTOMER' | 'OWNER' | 'COACH';
export type MembershipRole = 'OWNER' | 'ADMIN' | 'COACH';
/** A club or academy collects lesson money; a solo practice is paid directly. */
export type BusinessKind = 'CLUB' | 'SOLO';
export type Business = { id: string; name: string; slug: string; ownerName: string; email: string; timezone: string; currency: string; color: string; tagline: string; cancellationHours: number; kind: BusinessKind; isDemo: boolean };
export type AccountUser = { id: string; name: string; email: string; accountType: AccountType; phone?: string; parentName?: string; role?: 'CUSTOMER' | MembershipRole };
export type WorkspaceUser = AccountUser & { role: MembershipRole; instructorId: string | null };
export type Membership = { id: string; userId: string; businessId: string; role: MembershipRole; instructorId: string | null; active: boolean; createdAt: string; business: Business };
export type AuthSession = { user: AccountUser; membership: Membership | null; business: Business | null; memberships: Membership[] };
export type Instructor = { id: string; name: string; initials: string; color: string; email: string; specialty: string; rescheduleNoticeHours: number; active: boolean };
export type Location = { id: string; name: string; address: string; type: 'FACILITY' | 'RENTED' | 'HOME' | 'ONLINE'; color: string; requiresApproval: boolean; travelMinutes: number; notes: string; source: VenueSource; placeId: string; mapsUrl: string; latitude: number | null; longitude: number | null; active: boolean };
export type VenueSource = 'MANUAL' | 'GOOGLE_MAPS';
export type VenueCandidate = { placeId: string; name: string; address: string; mapsUrl: string; latitude: number | null; longitude: number | null; source: VenueSource };
export type VenueSearchResult = { configured: boolean; results: VenueCandidate[] };
export type PublicInstructor = Pick<Instructor, 'id' | 'name' | 'initials' | 'color' | 'specialty' | 'active'>;
export type PublicLocation = Pick<Location, 'id' | 'name' | 'address' | 'type' | 'color' | 'requiresApproval' | 'active'> & { mapsUrl?: string };
export type PublicBookingBusiness = Pick<Business, 'name' | 'slug' | 'ownerName' | 'timezone' | 'currency' | 'color' | 'tagline' | 'cancellationHours'> & { kind?: BusinessKind };
export type ServiceLocation = { locationId: string; price: number; duration: number; instructorIds: string[] };
export type Service = { id: string; name: string; description: string; category: string; type: 'PRIVATE' | 'GROUP'; duration: number; price: number; capacity: number; bufferMinutes: number; noticeHours: number; color: string; active: boolean; locations: ServiceLocation[] };
export type Availability = { id: string; instructorId: string; locationId: string; dayOfWeek: number; startTime: string; endTime: string };
export type AvailabilityException = { id: string; instructorId: string; date: string; reason: string };
export type Customer = { id: string; userId: string | null; name: string; email: string; phone: string; initials: string; notes: string; parentName: string; createdAt: string; bookingCount: number; lastBookingAt: string | null };
export type LessonPackage = { id: string; customerId: string; customerName: string; name: string; serviceId: string | null; totalCredits: number; usedCredits: number; price: number; expiresAt: string; paid: boolean };
export type Participant = { id: string; customerId: string; name: string; email: string; attendance: 'UNMARKED' | 'PRESENT' | 'ABSENT'; paid: boolean; price: number; packageId: string | null; notes: string; cancelled?: boolean; cancelledAt?: string | null };
/** "CLUB" runs the money through the club's books; "DIRECT" goes to the coach. */
export type PaymentRoute = 'CLUB' | 'DIRECT';
export type CoachAcceptance = 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' | 'DECLINED';
export type Booking = { id: string; serviceId: string; serviceName: string; instructorId: string; instructorName: string; locationId: string; locationName: string; locationColor: string; startAt: string; endAt: string; status: Status; type: 'PRIVATE' | 'GROUP'; capacity: number; price: number; paymentRoute: PaymentRoute; coachAcceptance: CoachAcceptance; createdByRole: 'CUSTOMER' | 'CLUB' | 'COACH'; notes?: string; address: string; recurringId: string | null; participants: Participant[] };

export type RescheduleStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';
export type RescheduleRequest = {
  id: string; bookingId: string; participantId: string | null;
  requestedByRole: 'CUSTOMER' | 'COACH' | 'CLUB'; requestedByUserId: string | null;
  proposedStartAt: string; proposedEndAt: string; originalStartAt: string;
  message: string; status: RescheduleStatus; respondedAt: string | null; responseMessage: string;
  createdAt: string; serviceName: string; instructorName: string; locationName: string;
  businessName: string; timezone: string;
};

export type IntegrityFlag = {
  id: string; instructorId: string | null; coachName: string; customerName: string;
  type: string; status: 'OPEN' | 'REVIEWING' | 'DISMISSED' | 'UPHELD';
  detail: string; occurrences: number; outsideBusinessName: string;
  firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null; resolutionNote: string;
  flaggedSessionAt: string | null; flaggedServiceName: string | null;
};
export type PaymentKind = 'CUSTOMER_TO_CLUB' | 'CUSTOMER_TO_COACH' | 'CLUB_TO_COACH';
export type Payment = { id: string; customerId: string; customerName: string; instructorId: string | null; instructorName: string | null; bookingId: string | null; packageId: string | null; kind: PaymentKind; amount: number; method: 'CASH' | 'BANK_TRANSFER' | 'OTHER'; note: string; paidAt: string; reversedAt: string | null; reversedReason: string };
/** Shared alert vocabulary; see backend/src/notifications.ts. */
export type NotificationType = 'BOOKING' | 'PAYMENT' | 'PAYOUT' | 'RESCHEDULE' | 'CANCELLATION' | 'PENDING_ACTION' | 'INTEGRITY' | 'ATTENDANCE' | 'NOTICE';
export type Notification = { id: string; type: NotificationType; bookingId: string | null; title: string; message: string; read: boolean; actionNeeded: boolean; createdAt: string };
export type Workspace = { business: Business; user: WorkspaceUser; membership: Membership; memberships: Membership[]; clubAccount: boolean; instructors: Instructor[]; locations: Location[]; services: Service[]; availability: Availability[]; exceptions: AvailabilityException[]; customers: Customer[]; packages: LessonPackage[]; bookings: Booking[]; payments: Payment[]; notifications: Notification[]; rescheduleRequests: RescheduleRequest[]; integrityFlags: IntegrityFlag[] };
export type Slot = { startAt: string; endAt: string; available: boolean; placesRemaining: number; reason?: string };
export type PublicBusiness = { business: PublicBookingBusiness; instructors: PublicInstructor[]; locations: PublicLocation[]; services: Service[] };
export type BookingInput = { serviceId: string; instructorId: string; locationId: string; startAt: string; customerId: string; repeatWeeks?: number; packageId?: string; notes?: string; address?: string };
export type PublicBookingInput = { serviceId: string; instructorId: string; locationId: string; startAt: string; customer?: { phone?: string; parentName?: string }; repeatWeeks?: number; notes?: string; address?: string };
export type BookingResult = { bookings: Booking[]; conflicts?: { date: string; reason: string }[] };
export type AccountBooking = {
  business: PublicBookingBusiness; booking: Booking; participant: Participant; location?: PublicLocation;
  canCancel?: boolean; canReschedule?: boolean;
  rescheduleRequest?: RescheduleRequest | null;
  awaitingCoach?: boolean;
  paymentRoute?: PaymentRoute;
  management?: { cancellationHours: number; rescheduleNoticeHours?: number; reminders?: string; venueReserved?: boolean };
};
export type AccountBookingsResult = { bookings: AccountBooking[] };
