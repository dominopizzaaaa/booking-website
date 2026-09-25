'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock3, MapPin, Users, Pencil, Layers3, Globe2, Home, Building2, ArrowUpRight, Mail, CalendarDays, Search, Loader2, ExternalLink, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, loadRental, mutate, saveRentalLocation, searchVenues } from '@/lib/api';
import { isManagerWorkspace, type Instructor, type Location, type RentalConfigValues, type RentalDetail, type Service, type ServiceLocation, type VenueCandidate } from '@/lib/types';
import { initials, money } from '@/lib/utils';
import { CheckField, Editor, Empty, Field, PageHeading, StateBadge, cents, numeric, text, type ManagementProps, type WorkspaceProps } from './management-ui';
import { StaffAccess } from './staff-access';

export function ServicesView({ data, refresh }: ManagementProps) {
  const [editing, setEditing] = useState<Service | null | undefined>();
  const [filter, setFilter] = useState('active');
  const services = data.services.filter(s => filter === 'all' || (filter === 'active' ? s.active : !s.active));
  return <><PageHeading title="Classes" description="Your expertise, thoughtfully packaged. Set up the classes students can book." action={() => setEditing(null)} actionLabel="Add class" /><div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e9e0] bg-white p-3 sm:px-4"><p className="text-xs text-stone-500"><strong className="font-semibold text-[#405941]">{data.services.filter(s => s.active).length}</strong> active classes <span className="mx-2 text-stone-300">·</span> Prices in SGD</p><select className="text-xs max-sm:w-full sm:max-w-44" aria-label="Filter classes" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Active classes</option><option value="archived">Archived classes</option><option value="all">All classes</option></select></div>{services.length ? <div className="cards-grid">{services.map(service => <article className="panel flex flex-col overflow-hidden transition-shadow hover:shadow-sm" key={service.id}><div className="h-1" style={{ backgroundColor: service.color }} /><div className="flex h-full flex-col p-5"><div className="mb-5 flex items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f0f4e9] text-[#7a9367]"><Layers3 size={20} strokeWidth={1.4} /></span><StateBadge active={service.active} /></div><p className="eyebrow mb-2">{service.category || 'Classes'}</p><h2 className="text-base text-[#294735]">{service.name}</h2><p className="mt-2 min-h-10 text-xs leading-relaxed text-stone-500">{service.description || 'A little space to practise, learn, and grow.'}</p><div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-[#7b867d]"><span className="flex items-center gap-1.5"><Clock3 size={13} />{service.duration} min</span><span className="flex items-center gap-1.5"><Users size={13} />{service.type === 'GROUP' ? `Group · up to ${service.capacity}` : 'Private'}</span></div><div className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-stone-500"><MapPin size={13} className="mt-0.5 shrink-0" />{service.locations.length ? service.locations.map(l => data.locations.find(x => x.id === l.locationId)?.name || 'Archived location').join(', ') : 'No locations assigned'}</div><div className="mt-6 flex items-center justify-between border-t border-[#edf0e8] pt-4"><div><span className="text-xl font-semibold tracking-tight text-[#254b38]">{money(service.price)}</span><span className="ml-1 text-[10px] text-stone-400">/ person</span></div><Button variant="outline" size="sm" onClick={() => setEditing(service)} aria-label={`Edit ${service.name}`}><Pencil size={13} />Edit</Button></div></div></article>)}</div> : <div className="panel"><Empty title="Room for something new" icon={Layers3}>No {filter === 'all' ? '' : filter} classes yet. Add a class, then connect its locations and instructors.</Empty></div>}{editing !== undefined && <ServiceEditor service={editing} data={data} refresh={refresh} onClose={() => setEditing(undefined)} />}</>;
}

function ServiceEditor({ service, data, refresh, onClose }: ManagementProps & { service: Service | null; onClose: () => void }) {
  const [type, setType] = useState(service?.type || 'PRIVATE');
  const [defaultPrice, setDefaultPrice] = useState(String((service?.price ?? 8000) / 100));
  const [defaultDuration, setDefaultDuration] = useState(String(service?.duration ?? 60));
  const [locations, setLocations] = useState<Record<string, { price: string; duration: string; instructorIds: string[] }>>(() => Object.fromEntries((service?.locations || []).map(l => [l.locationId, { price: String(l.price / 100), duration: String(l.duration), instructorIds: [...l.instructorIds] }])));
  function toggleLocation(locationId: string, checked: boolean) { setLocations(previous => { const next = { ...previous }; if (checked) next[locationId] = { price: defaultPrice, duration: defaultDuration, instructorIds: [] }; else delete next[locationId]; return next; }); }
  function update(locationId: string, change: Partial<{ price: string; duration: string; instructorIds: string[] }>) { setLocations(previous => ({ ...previous, [locationId]: { ...previous[locationId], ...change } })); }
  return <Editor title={service ? 'Edit class' : 'Create a class'} description="Default pricing is per participant. Each location can have its own price, duration, and instructor roster." wide onClose={onClose} refresh={refresh} submitLabel={service ? 'Save class' : 'Create class'} success="Class saved" onSubmit={async form => {
    const mappings: ServiceLocation[] = Object.entries(locations).map(([locationId, value]) => ({ locationId, price: cents(value.price), duration: Number(value.duration), instructorIds: value.instructorIds }));
    if (!mappings.length) throw new Error('Choose at least one location for this class.');
    if (mappings.some(l => !l.instructorIds.length)) throw new Error('Choose at least one instructor for every selected location.');
    await mutate(`/services${service ? `/${service.id}` : ''}`, service ? 'PATCH' : 'POST', { name: text(form, 'name'), description: text(form, 'description'), category: text(form, 'category'), type, duration: Number(defaultDuration), price: cents(defaultPrice), capacity: type === 'PRIVATE' ? 1 : numeric(form, 'capacity'), bufferMinutes: numeric(form, 'bufferMinutes'), noticeHours: numeric(form, 'noticeHours'), color: text(form, 'color'), active: form.has('active'), locations: mappings });
  }}><div className="form-grid max-sm:grid-cols-1!"><Field label="Class name" name="name" defaultValue={service?.name} required wide placeholder="e.g. Private tennis class" /><Field label="Category" name="category" defaultValue={service?.category || 'Tennis'} required /><Field label="Class format" name="service-type"><select id="service-type" value={type} onChange={e => setType(e.target.value as Service['type'])} required><option value="PRIVATE">Private · one participant</option><option value="GROUP">Group class</option></select></Field><Field label="Description" name="service-description" wide><textarea id="service-description" name="description" defaultValue={service?.description} rows={3} placeholder="Who is this for, and what will they learn?" /></Field><Field label="Default price (SGD)" name="price" type="number" min="0" step="0.01" value={defaultPrice} onChange={e => setDefaultPrice(e.target.value)} required /><Field label="Default duration (minutes)" name="duration" type="number" min="15" max="480" step="5" value={defaultDuration} onChange={e => setDefaultDuration(e.target.value)} required />{type === 'GROUP' && <Field label="Participant capacity" name="capacity" type="number" min="2" max="100" step="1" defaultValue={Math.max(2, service?.capacity || 4)} required />}<Field label="Preparation buffer before class (minutes)" name="bufferMinutes" type="number" min="0" max="240" step="5" defaultValue={service?.bufferMinutes ?? 15} required /><Field label="Minimum booking notice (hours)" name="noticeHours" type="number" min="0" max="720" step="1" defaultValue={service?.noticeHours ?? 12} required /><Field label="Calendar colour" name="color" type="color" defaultValue={service?.color || '#8fa875'} required /></div><section className="rounded-xl border border-[#e6eae3] p-4"><h3 className="text-sm">Where it happens</h3><p className="mt-1 mb-4 text-[11px] leading-relaxed text-stone-500">Select locations and the instructors who can teach here. Prices below override the default.</p>{!data.locations.length && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Create a location first, then return to add your class.</p>}<div className="space-y-3">{data.locations.map(location => <div key={location.id} className="rounded-lg border border-[#e6eae3] p-3"><label className="mb-0 flex items-center gap-2.5"><input type="checkbox" checked={!!locations[location.id]} onChange={e => toggleLocation(location.id, e.target.checked)} />{location.name}{!location.active && <span className="text-stone-400">(archived)</span>}</label>{locations[location.id] && <div className="mt-4 space-y-4"><div className="form-grid"><Field label="Price (SGD)" name={`price-${location.id}`} type="number" min="0" step="0.01" required value={locations[location.id].price} onChange={e => update(location.id, { price: e.target.value })} /><Field label="Duration (minutes)" name={`duration-${location.id}`} type="number" min="15" max="480" step="5" required value={locations[location.id].duration} onChange={e => update(location.id, { duration: e.target.value })} /></div><fieldset><legend className="mb-2 text-xs font-medium">Available instructors <span className="text-stone-400">(select at least one)</span></legend><div className="flex flex-wrap gap-3">{data.instructors.map(instructor => <label key={instructor.id} className="mb-0 flex items-center gap-2 text-[11px] font-normal"><input type="checkbox" checked={locations[location.id].instructorIds.includes(instructor.id)} onChange={e => update(location.id, { instructorIds: e.target.checked ? [...locations[location.id].instructorIds, instructor.id] : locations[location.id].instructorIds.filter(id => id !== instructor.id) })} />{instructor.name}{!instructor.active && ' (archived)'}</label>)}</div>{!data.instructors.length && <p className="text-xs text-amber-800">Add an instructor in Team first.</p>}</fieldset></div>}</div>)}</div></section><CheckField name="active" label="Available for booking" hint="Turn off to archive the class. Existing bookings are preserved." defaultChecked={service?.active ?? true} /></Editor>;
}

const locationNames: Record<Location['type'], string> = { FACILITY: 'Own facility', RENTED: 'Rented venue', HOME: 'Student home', ONLINE: 'Online' };
const locationIcons = { FACILITY: Building2, RENTED: MapPin, HOME: Home, ONLINE: Globe2 };
export function LocationsView({ data, refresh }: WorkspaceProps) {
  const [editing, setEditing] = useState<Location | null | undefined>();
  const canManage = isManagerWorkspace(data);
  const canConfigureRental = canManage && data.user.accountType === 'CLUB';
  const description = canManage
    ? 'A home for every class. Search Google Maps for a venue, or add one by hand, and keep travel time and approvals with it.'
    : 'Find a teaching venue on Google Maps or add one by hand. The club manages existing venue settings and class assignments.';
  return <><PageHeading title="Locations" description={description} action={() => setEditing(null)} actionLabel="Add location" /><div className="mb-5 flex items-center gap-2 rounded-xl border border-[#e5e9e0] bg-white px-4 py-3 text-xs text-stone-500"><MapPin size={14} /><strong className="font-semibold text-[#405941]">{data.locations.filter(l => l.active).length}</strong> active locations</div>{data.locations.length ? <div className="cards-grid">{data.locations.map(location => { const Icon = locationIcons[location.type]; return <article className="panel flex flex-col p-5 transition-shadow hover:shadow-sm" key={location.id}><div className="mb-5 flex items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f1f5ec]" style={{ color: location.color }}><Icon size={23} strokeWidth={1.4} /></span><StateBadge active={location.active} /></div><p className="eyebrow mb-2">{locationNames[location.type]}</p><h2 className="text-base text-[#294735]">{location.name}</h2><p className="mt-2 min-h-10 text-xs leading-relaxed text-stone-500">{location.address || (location.type === 'HOME' ? 'Address is provided by the student.' : location.type === 'ONLINE' ? 'Online session details are arranged separately.' : 'No address added yet.')}</p><div className="mt-5 space-y-2 text-[11px] text-stone-500"><p className="flex items-center gap-2"><Clock3 size={13} />{location.travelMinutes} min travel allowance</p>{canManage && <p className="flex items-center gap-2"><Layers3 size={13} />{data.services.filter(s => s.locations.some(l => l.locationId === location.id)).length} connected classes</p>}{location.requiresApproval && <span className="badge pending">Venue confirmation required</span>}{location.mapsUrl && <a href={location.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5d7a52]">Open in Google Maps <ExternalLink size={11} /></a>}</div>{location.notes && <p className="mt-4 border-l-2 border-[#dfe7d3] pl-3 text-[11px] leading-relaxed text-stone-500">{location.notes}</p>}{canManage && <div className="mt-auto pt-5"><Button variant="outline" size="sm" className="w-full" onClick={() => setEditing(location)}><Pencil size={13} />Edit location<ArrowUpRight size={13} className="ml-auto" /></Button></div>}</article>; })}</div> : <div className="panel"><Empty title="Every class starts somewhere" icon={MapPin}>Add a facility, a rented venue, a student home, or an online location.</Empty></div>}{editing !== undefined && <LocationEditor location={canManage ? editing : null} currency={data.business.currency} canManage={canManage} canConfigureRental={canConfigureRental} refresh={refresh} onClose={() => setEditing(undefined)} />}</>;
}

/**
 * Find a venue on Google Maps instead of typing it.
 *
 * Two paths, because only one of them always works. When the server has a
 * Places key, a search returns real venues. When it does not, a pasted Maps
 * link is read locally — people already share venues as links, so this is the
 * dependable route rather than a degraded one. Either way the place name,
 * address and coordinates fill the form, and typing an address by hand stays
 * available for somewhere Maps has never heard of.
 */
function VenueFinder({ onPick }: { onPick: (venue: VenueCandidate) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VenueCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  async function run() {
    const value = query.trim();
    if (value.length < 2) return;
    setSearching(true);
    setError('');
    setResults([]);
    try {
      const found = await searchVenues(value);
      setResults(found.results);
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Venue search is unavailable right now.');
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }

  return <section className="rounded-xl border border-[#e6eae3] bg-[#fafbf8] p-4">
    <h3 className="flex items-center gap-2 text-sm text-[#294735]"><MapPin size={15} />Find it on Google Maps</h3>
    <p className="mt-1 text-[11px] leading-relaxed text-stone-500">Search for the venue, or paste a Google Maps link. The name, address, and location fill in below.</p>
    <div className="mt-3 flex gap-2 max-sm:flex-col">
      <input
        aria-label="Search for a venue"
        value={query}
        onChange={event => { setQuery(event.target.value); setError(''); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void run(); } }}
        placeholder="e.g. Kallang Tennis Centre, or a Maps link"
        className="min-w-0 flex-1"
      />
      <Button type="button" variant="outline" className="shrink-0" disabled={searching || query.trim().length < 2} onClick={() => void run()}>
        {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Search
      </Button>
    </div>
    {error && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">{error}</p>}
    {results.length > 0 && <ul className="mt-3 space-y-2">{results.map(venue => <li key={`${venue.placeId}:${venue.name}`}>
      <button
        type="button"
        onClick={() => onPick(venue)}
        className="flex w-full items-start gap-2.5 rounded-lg border border-[#e3e8df] bg-white p-3 text-left transition hover:border-[#cbd8c5] hover:bg-[#f7f9f4]"
      >
        <MapPin size={15} className="mt-0.5 shrink-0 text-[#839677]" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-[#344b39]">{venue.name}</span>
          {venue.address && <span className="mt-1 block text-[10px] leading-relaxed text-stone-500">{venue.address}</span>}
        </span>
        <Check size={14} className="mt-0.5 shrink-0 text-[#7a9367]" />
      </button>
    </li>)}</ul>}
    {searched && !searching && !error && !results.length && <p className="mt-3 text-[11px] text-stone-500">No venues matched. Try a fuller name, or type the address in by hand below.</p>}
  </section>;
}

const rentalDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const defaultRentalHours = rentalDays.map((_, dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '22:00' }));

type RentalDraft = {
  enabled: boolean; loadedEnabled: boolean; sport: string; rules: string; amenities: string; unitLabel: string;
  price: string; startInterval: number; minDuration: string; durationIncrement: number; maxDuration: string;
  noticeHours: string; advanceDays: string; cancellationHours: string;
  units: Array<{ id?: string; name: string; active: boolean }>; openingHours: RentalDetail['openingHours'];
};

function emptyRentalDraft(): RentalDraft {
  return {
    enabled: false, loadedEnabled: false, sport: '', rules: '', amenities: '', unitLabel: 'Court', price: '30',
    startInterval: 60, minDuration: '60', durationIncrement: 60, maxDuration: '180', noticeHours: '2',
    advanceDays: '60', cancellationHours: '24', units: [{ name: 'Court 1', active: true }], openingHours: defaultRentalHours,
  };
}

function rentalDraft(detail: RentalDetail): RentalDraft {
  return {
    enabled: detail.enabled, loadedEnabled: detail.enabled, sport: detail.sport, rules: detail.rules,
    amenities: detail.amenities.join('\n'), unitLabel: detail.unitLabel, price: String(detail.price / 100),
    startInterval: detail.startInterval, minDuration: String(detail.minDuration),
    durationIncrement: detail.durationIncrement, maxDuration: String(detail.maxDuration),
    noticeHours: String(detail.noticeHours), advanceDays: String(detail.advanceDays),
    cancellationHours: String(detail.cancellationHours),
    units: detail.units.some(unit => unit.active)
      ? detail.units.filter(unit => unit.active).map(unit => ({ ...unit }))
      : [{ name: `${detail.unitLabel || 'Court'} 1`, active: true }],
    openingHours: detail.openingHours.length ? detail.openingHours.map(hour => ({ ...hour })) : defaultRentalHours,
  };
}

function wholeNumber(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
  return number;
}

function newRentalLocationId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `rental_loc_${random}`;
}

function LocationEditor({ location, currency, canManage, canConfigureRental, refresh, onClose }: { location: Location | null; currency: string; canManage: boolean; canConfigureRental: boolean; refresh: () => Promise<void>; onClose: () => void }) {
  // The venue identity a Maps lookup filled in, kept separate from the free
  // text so an edited address never silently claims to be a Maps result.
  const [name, setName] = useState(location?.name ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [place, setPlace] = useState<VenueCandidate | null>(
    location?.source === 'GOOGLE_MAPS'
      ? {
        placeId: location.placeId, name: location.name, address: location.address,
        mapsUrl: location.mapsUrl, latitude: location.latitude, longitude: location.longitude,
        source: 'GOOGLE_MAPS',
      }
      : null,
  );
  const [locationType, setLocationType] = useState<Location['type']>(location?.type ?? 'FACILITY');
  const [rental, setRental] = useState<RentalDraft>(() => emptyRentalDraft());
  const [rentalLoading, setRentalLoading] = useState(canConfigureRental && !!location);
  const [rentalLoadError, setRentalLoadError] = useState('');
  // The generated id remains stable while the editor is open. A retry after a
  // lost response therefore replays the same create instead of duplicating it.
  const savedLocationId = useRef(location?.id ?? newRentalLocationId());
  const rentalAvailable = canConfigureRental && locationType === 'FACILITY';

  useEffect(() => {
    if (!canConfigureRental || !location) return;
    let cancelled = false;
    setRentalLoading(true);
    setRentalLoadError('');
    loadRental(location.id).then(detail => {
      if (!cancelled) setRental(rentalDraft(detail));
    }).catch(cause => {
      if (cancelled) return;
      if (cause instanceof ApiError && cause.status === 404) setRental(emptyRentalDraft());
      else setRentalLoadError(cause instanceof Error ? cause.message : 'Rental settings could not be loaded.');
    }).finally(() => { if (!cancelled) setRentalLoading(false); });
    return () => { cancelled = true; };
  }, [canConfigureRental, location]);

  function updateUnit(index: number, name: string) {
    setRental(previous => ({ ...previous, units: previous.units.map((unit, unitIndex) => unitIndex === index ? { ...unit, name } : unit) }));
  }

  function setUnitCount(value: string) {
    const count = Math.max(1, Math.min(100, Number(value) || 1));
    setRental(previous => ({
      ...previous,
      units: Array.from({ length: count }, (_, index) => previous.units[index] ?? { name: `${previous.unitLabel || 'Court'} ${index + 1}`, active: true }),
    }));
  }

  function toggleOpeningDay(dayOfWeek: number, enabled: boolean) {
    setRental(previous => ({
      ...previous,
      openingHours: enabled
        ? [...previous.openingHours, { dayOfWeek, startTime: '08:00', endTime: '22:00' }].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
        : previous.openingHours.filter(hour => hour.dayOfWeek !== dayOfWeek),
    }));
  }

  function updateOpeningDay(dayOfWeek: number, change: Partial<{ startTime: string; endTime: string }>) {
    setRental(previous => ({ ...previous, openingHours: previous.openingHours.map(hour => hour.dayOfWeek === dayOfWeek ? { ...hour, ...change } : hour) }));
  }

  function pick(venue: VenueCandidate) {
    setPlace(venue);
    setName(venue.name);
    if (venue.address) setAddress(venue.address);
  }

  return <Editor title={location ? 'Edit location' : 'Add a location'} description="Venue approval is a scheduling workflow, not an external venue reservation." wide onClose={onClose} refresh={refresh} success="Location saved" submitLabel="Save location" disabled={rentalLoading || !!rentalLoadError} onSubmit={async form => {
    let rentalValues: RentalConfigValues | undefined;
    if (canConfigureRental && rental.enabled && locationType === 'FACILITY') {
      rentalValues = {
        sport: rental.sport.trim(), rules: rental.rules.trim(),
        amenities: rental.amenities.split(/[\n,]/u).map(value => value.trim()).filter(Boolean),
        unitLabel: rental.unitLabel.trim(), price: cents(rental.price), startInterval: rental.startInterval,
        minDuration: wholeNumber(rental.minDuration, 'Minimum rental duration'),
        durationIncrement: rental.durationIncrement, maxDuration: wholeNumber(rental.maxDuration, 'Maximum rental duration'),
        noticeHours: wholeNumber(rental.noticeHours, 'Minimum booking notice'),
        advanceDays: wholeNumber(rental.advanceDays, 'Maximum advance booking'),
        cancellationHours: wholeNumber(rental.cancellationHours, 'Cancellation notice'),
        units: rental.units.map(unit => ({ ...unit, name: unit.name.trim() })), openingHours: rental.openingHours,
      };
      if (!rentalValues.sport) throw new Error('Enter the sport for this training ground.');
      if (!rentalValues.unitLabel) throw new Error('Enter a name for the rentable units.');
      if (rentalValues.units.some(unit => !unit.name)) throw new Error('Give every rental unit a name.');
      const unitNames = rentalValues.units.map(unit => unit.name.toLocaleLowerCase());
      if (new Set(unitNames).size !== unitNames.length) throw new Error('Rental unit names must be unique.');
      if (!rentalValues.openingHours.length) throw new Error('Choose at least one opening day.');
      if (rentalValues.openingHours.some(hours => hours.startTime >= hours.endTime)) throw new Error('Each opening time must end after it starts.');
      if (rentalValues.maxDuration < rentalValues.minDuration) throw new Error('Maximum rental duration cannot be shorter than the minimum.');
      if (rentalValues.minDuration < rentalValues.durationIncrement
        || rentalValues.minDuration % rentalValues.durationIncrement !== 0
        || rentalValues.maxDuration % rentalValues.durationIncrement !== 0) {
        throw new Error('Rental durations must be divisible by the duration increment.');
      }
    }
    const locationValues = {
      name: text(form, 'name'), address: text(form, 'address'), type: locationType,
      color: text(form, 'color'), requiresApproval: form.has('requiresApproval'),
      travelMinutes: numeric(form, 'travelMinutes'), notes: text(form, 'notes'), active: canManage ? form.has('active') : true,
      source: place ? 'GOOGLE_MAPS' : 'MANUAL',
      placeId: place?.placeId ?? '',
      mapsUrl: place?.mapsUrl ?? '',
      latitude: place?.latitude ?? null,
      longitude: place?.longitude ?? null,
    } satisfies Omit<Location, 'id'>;
    if (canConfigureRental) {
      await saveRentalLocation(savedLocationId.current, {
        mode: location ? 'UPDATE' : 'CREATE', location: locationValues,
        rental: rentalValues ? { enabled: true, ...rentalValues } : { enabled: false },
      });
      return;
    }
    // Coaches may add a teaching venue, but rental configuration remains a
    // club-only aggregate and therefore stays on the generic venue route.
    await mutate<Location>('/locations', 'POST', locationValues);
  }}>
    <VenueFinder onPick={pick} />
    {place && <div className="flex items-start gap-3 rounded-xl border border-[#dfe7d3] bg-[#f3f7ed] p-3">
      <MapPin size={16} className="mt-0.5 shrink-0 text-[#6f875e]" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-[#344b39]">Linked to a Google Maps place</p>
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">{place.latitude !== null && place.longitude !== null ? `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}` : 'Coordinates were not included in this result.'}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {place.mapsUrl && <a href={place.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#5d7a52]">Open in Maps <ExternalLink size={10} /></a>}
          <button type="button" className="text-[10px] font-semibold text-stone-500 underline underline-offset-2" onClick={() => setPlace(null)}>Unlink</button>
        </div>
      </div>
    </div>}
    <div className="form-grid max-sm:grid-cols-1!"><Field name="name" label="Location name" value={name} onChange={event => setName(event.target.value)} required wide /><Field name="location-type" label="Location type"><select id="location-type" name="location-type" value={locationType} onChange={event => setLocationType(event.target.value as Location['type'])} required>{Object.entries(locationNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field><Field name="travelMinutes" label="Travel allowance (minutes)" type="number" min="0" max="240" step="5" defaultValue={location?.travelMinutes ?? 15} required /><Field name="address" label="Address or meeting details" value={address} onChange={event => setAddress(event.target.value)} wide hint="For home visits, the student supplies their address when booking." /><Field name="color" label="Calendar colour" type="color" defaultValue={location?.color || '#8fa875'} /><Field name="location-notes" label="Venue notes" wide><textarea id="location-notes" name="notes" defaultValue={location?.notes} rows={3} placeholder="Access details, equipment, or booking instructions" /></Field></div><CheckField label="Require venue confirmation" name="requiresApproval" defaultChecked={location?.requiresApproval ?? false} hint="Bookings stay pending until you confirm the venue has been secured separately." />{canManage && <CheckField label="Active location" name="active" defaultChecked={location?.active ?? true} hint="Archive to hide this location from new public bookings. Existing classes are kept." />}
    {canConfigureRental && <RentalFields rental={rental} setRental={setRental} currency={currency} available={rentalAvailable} loading={rentalLoading} error={rentalLoadError} onRetry={() => {
      if (!location) return;
      setRentalLoading(true); setRentalLoadError('');
      loadRental(location.id).then(detail => setRental(rentalDraft(detail))).catch(cause => {
        if (cause instanceof ApiError && cause.status === 404) setRental(emptyRentalDraft());
        else setRentalLoadError(cause instanceof Error ? cause.message : 'Rental settings could not be loaded.');
      }).finally(() => setRentalLoading(false));
    }} updateUnit={updateUnit} setUnitCount={setUnitCount} toggleOpeningDay={toggleOpeningDay} updateOpeningDay={updateOpeningDay} />}
  </Editor>;
}

function RentalFields({ rental, setRental, currency, available, loading, error, onRetry, updateUnit, setUnitCount, toggleOpeningDay, updateOpeningDay }: {
  rental: RentalDraft; setRental: (update: (previous: RentalDraft) => RentalDraft) => void; available: boolean;
  currency: string;
  loading: boolean; error: string; onRetry: () => void; updateUnit: (index: number, name: string) => void;
  setUnitCount: (value: string) => void; toggleOpeningDay: (dayOfWeek: number, enabled: boolean) => void;
  updateOpeningDay: (dayOfWeek: number, change: Partial<{ startTime: string; endTime: string }>) => void;
}) {
  if (loading) return <section className="rounded-xl border border-[#e6eae3] bg-[#fafbf8] p-4" aria-live="polite"><p className="flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Loading rental settings…</p></section>;
  if (error) return <section className="rounded-xl border border-red-200 bg-red-50 p-4"><p className="text-xs leading-relaxed text-red-700" role="alert">{error}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>Retry rental settings</Button></section>;
  if (!available) return <section className="rounded-xl border border-[#e6eae3] bg-[#fafbf8] p-4"><h3 className="text-sm text-[#294735]">Training ground rental</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">Public rental is available only when the location type is Own facility.{rental.loadedEnabled ? ' Saving this location type will disable its rental listing.' : ''}</p></section>;

  return <section className="space-y-5 rounded-xl border border-[#dfe7d3] bg-[#fafbf8] p-4 sm:p-5">
    <div><h3 className="text-sm text-[#294735]">Training ground rental</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">Let players reserve this facility independently of a coached class.</p></div>
    <CheckField name="rental-enabled" label="Offer this location for public rental" checked={rental.enabled} onChange={event => setRental(previous => ({ ...previous, enabled: event.target.checked }))} hint="Turning this off removes the public listing while preserving the teaching location." />
    {rental.enabled && <>
      <div className="form-grid max-sm:grid-cols-1!">
        <Field label="Sport" name="rental-sport" value={rental.sport} onChange={event => setRental(previous => ({ ...previous, sport: event.target.value }))} required placeholder="e.g. Tennis" />
        <Field label={`Hourly rate (${currency})`} name="rental-price" type="number" min="0" step="0.01" value={rental.price} onChange={event => setRental(previous => ({ ...previous, price: event.target.value }))} required />
        <Field label="Unit label" name="rental-unit-label" value={rental.unitLabel} onChange={event => setRental(previous => ({ ...previous, unitLabel: event.target.value }))} required hint="Singular name shown to players, such as Court or Table." />
        <Field label="Number of units" name="rental-unit-count" type="number" min="1" max="100" step="1" value={rental.units.length} onChange={event => setUnitCount(event.target.value)} required />
        <Field label="Booking start interval (minutes)" name="rental-start-interval"><select id="rental-start-interval" value={rental.startInterval} onChange={event => setRental(previous => ({ ...previous, startInterval: Number(event.target.value) }))} required><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select></Field>
        <Field label="Minimum rental duration (minutes)" name="rental-min-duration" type="number" min="5" max="1440" step="5" value={rental.minDuration} onChange={event => setRental(previous => ({ ...previous, minDuration: event.target.value }))} required />
        <Field label="Duration increment (minutes)" name="rental-duration-increment"><select id="rental-duration-increment" value={rental.durationIncrement} onChange={event => setRental(previous => ({ ...previous, durationIncrement: Number(event.target.value) }))} required><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select></Field>
        <Field label="Maximum rental duration (minutes)" name="rental-max-duration" type="number" min="5" max="1440" step="5" value={rental.maxDuration} onChange={event => setRental(previous => ({ ...previous, maxDuration: event.target.value }))} required />
        <Field label="Minimum booking notice (hours)" name="rental-notice-hours" type="number" min="0" max="8760" step="1" value={rental.noticeHours} onChange={event => setRental(previous => ({ ...previous, noticeHours: event.target.value }))} required />
        <Field label="Maximum advance booking (days)" name="rental-advance-days" type="number" min="1" max="365" step="1" value={rental.advanceDays} onChange={event => setRental(previous => ({ ...previous, advanceDays: event.target.value }))} required />
        <Field label="Cancellation notice (hours)" name="rental-cancellation-hours" type="number" min="0" max="8760" step="1" value={rental.cancellationHours} onChange={event => setRental(previous => ({ ...previous, cancellationHours: event.target.value }))} required />
      </div>
      <fieldset className="rounded-xl border border-[#e6eae3] bg-white p-4"><legend className="px-1 text-xs font-semibold text-[#344b39]">Rental unit names</legend><div className="mt-2 grid gap-3 sm:grid-cols-2">{rental.units.map((unit, index) => <Field key={unit.id ?? index} label={`Unit ${index + 1} name`} name={`rental-unit-${index}`} value={unit.name} onChange={event => updateUnit(index, event.target.value)} required />)}</div></fieldset>
      <fieldset className="rounded-xl border border-[#e6eae3] bg-white p-4"><legend className="px-1 text-xs font-semibold text-[#344b39]">Opening hours</legend><p className="mb-3 text-[11px] leading-relaxed text-stone-500">Choose each day players may start and finish a rental.</p><div className="space-y-3">{rentalDays.map((day, dayOfWeek) => { const hours = rental.openingHours.find(hour => hour.dayOfWeek === dayOfWeek); return <div key={day} className="grid items-center gap-2 rounded-lg border border-[#edf0e8] p-3 sm:grid-cols-[8rem_1fr_1fr]"><label className="mb-0 flex items-center gap-2 text-xs font-medium"><input type="checkbox" checked={!!hours} onChange={event => toggleOpeningDay(dayOfWeek, event.target.checked)} />{day}</label>{hours ? <><label className="text-[11px] text-stone-500"><span className="mb-1 block">Opens</span><input type="time" aria-label={`${day} opening time`} value={hours.startTime} onChange={event => updateOpeningDay(dayOfWeek, { startTime: event.target.value })} required /></label><label className="text-[11px] text-stone-500"><span className="mb-1 block">Closes</span><input type="time" aria-label={`${day} closing time`} value={hours.endTime} onChange={event => updateOpeningDay(dayOfWeek, { endTime: event.target.value })} required /></label></> : <p className="text-[11px] text-stone-400 sm:col-span-2">Closed</p>}</div>; })}</div></fieldset>
      <div className="form-grid max-sm:grid-cols-1!">
        <Field label="Amenities" name="rental-amenities" wide hint="Enter one amenity per line."><textarea id="rental-amenities" rows={4} value={rental.amenities} onChange={event => setRental(previous => ({ ...previous, amenities: event.target.value }))} placeholder={'Lighting\nChanging rooms\nEquipment hire'} /></Field>
        <Field label="Rental rules" name="rental-rules" wide><textarea id="rental-rules" rows={4} value={rental.rules} onChange={event => setRental(previous => ({ ...previous, rules: event.target.value }))} placeholder="Arrival, footwear, equipment, and venue-use guidance" /></Field>
      </div>
    </>}
  </section>;
}

export function TeamView({ data, refresh }: ManagementProps) {
  const [editing, setEditing] = useState<Instructor>();
  return <>
    <PageHeading title="My coaches" description="Good classes start with good people. A club adds a coach to its roster; a coach cannot join a club themselves." />
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-[#e3e9db] bg-[#eff3e9] p-4"><Users size={18} className="mt-0.5 shrink-0 text-[#7a8d69]" /><p className="text-xs leading-relaxed text-[#6d7d62]">Every coach is connected to a <strong className="font-semibold">registered Courtly coach account</strong>. Ask the coach to create their own account first, then use Coach access below to add them. Their name and sign-in identity stay theirs.</p></div>
    {data.instructors.length ? <div className="cards-grid">{data.instructors.map(instructor => <article className="panel p-5 transition-shadow hover:shadow-sm" key={instructor.id}><span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2e6] text-lg font-medium" style={{ color: instructor.color }}>{instructor.initials || initials(instructor.name)}</span><h2 className="mt-4 text-base text-[#294735]">{instructor.name}</h2><p className="mt-5 flex items-center gap-2 break-all text-[11px] text-stone-500"><Mail size={13} className="shrink-0" />{instructor.email || 'No email added'}</p><p className="mt-2 flex items-center gap-2 text-[11px] text-stone-500"><Clock3 size={13} />{instructor.rescheduleNoticeHours} hour reschedule notice</p><p className="mt-2 flex items-center gap-2 text-[11px] text-stone-500"><CalendarDays size={13} />{data.availability.filter(a => a.instructorId === instructor.id).length} weekly availability windows</p><div className="mt-5 border-t border-[#edf0e8] pt-4"><Button variant="outline" size="sm" className="w-full" onClick={() => setEditing(instructor)}><Pencil size={13} />Edit roster details</Button></div></article>)}</div> : <div className="panel"><Empty title="Make room for your team" icon={Users}>Connect an existing coach account, then add availability and classes for them.</Empty></div>}
    {data.user.accountType === 'CLUB' && <StaffAccess data={data} refresh={refresh} />}
    {editing && <Editor title="Edit coach details" description="Update workspace-only scheduling details. The coach owns their name, email, password, and account identity." onClose={() => setEditing(undefined)} refresh={refresh} success="Coach details saved" submitLabel="Save roster details" onSubmit={form => mutate(`/instructors/${editing.id}`, 'PATCH', { color: text(form, 'color'), rescheduleNoticeHours: numeric(form, 'rescheduleNoticeHours') })}><div className="form-grid max-sm:grid-cols-1!"><div className="field-wide flex items-center gap-3 rounded-xl border border-[#e3e9db] bg-[#f8faf6] p-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#e9f0e2] text-[#617851]"><Mail size={17} /></span><div className="min-w-0"><p className="text-xs font-semibold text-[#344b39]">{editing.name}</p><p className="mt-1 break-all text-[11px] text-stone-500">{editing.email}</p><p className="mt-1 text-[10px] text-stone-400">Account identity is managed by the coach.</p></div></div><Field label="Calendar colour" name="color" type="color" defaultValue={editing.color || '#8fa875'} /><Field label="Reschedule notice (hours)" name="rescheduleNoticeHours" type="number" min="0" max="720" step="1" defaultValue={editing.rescheduleNoticeHours} required hint="How far ahead students must request a new class time." /></div></Editor>}
  </>;
}
