/**
 * Eczaneler (`docs/TASKS.md` F5.6, F5.6a): OpenStreetMap's pharmacies near the
 * person or in a province and district they choose, filtered and sorted on the
 * device, as a list everywhere and on a map on the phone. The position stays on
 * the device: the server is asked for a rounded box around it
 * (`docs/ARCHITECTURE.md` "The guide's data").
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { boxAround, pharmaciesIn, pharmaciesOf, pharmaciesShown, pharmacyPlaces, readPlace, savePlace, type Box, type Pharmacy, type Point } from "../services/guide";
import { Body, Button, Card, ChoiceTile, ListRow, Notice, ReadFailed, Screen, SectionHeader, TextField } from "../ui/components";
import { PharmacyRow, useAnswer } from "../ui/guide";
import { radioGroupKeys } from "../ui/keys";
import { HAS_MAP, PharmacyMap } from "../ui/pharmacy-map";
import { controlSize, spacing } from "../ui/theme";

// Asked for only on a tap, so the web's first load does not carry it.
const loadLocation = () => import("expo-location");

/** How far "near" reaches, widened a step at a time when it finds nothing. */
const REACH_KM = [5, 15, 40] as const;

type Located = { status: "idle" | "locating" | "denied" | "failed" } | { status: "ready"; at: Point };
/** `district` undefined is not chosen yet; null is the pharmacies OpenStreetMap places in no district. */
type Chosen = { province: string; district?: string | null };

// One question in one string, so `useAnswer` holds a box's answer apart from a district's.
const boxQuestion = (box: Box) => `box:${JSON.stringify(box)}`;
const placeQuestion = (place: Required<Chosen>) => `place:${JSON.stringify(place)}`;
function askPharmacies(question: string): Promise<Pharmacy[] | null> {
  const [kind, ...rest] = question.split(":");
  const asked = JSON.parse(rest.join(":"));
  return kind === "box" ? pharmaciesIn(asked as Box) : pharmaciesOf(asked.province, asked.district);
}

const middleOf = (box: Box): Point => ({ lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 });
const fold = (text: string) => text.trim().toLocaleLowerCase("tr-TR");

function Tiles<T extends string | boolean>({ label, options, value, onChoose }: { label: string; options: readonly { value: T; label: string }[]; value: T | null; onChoose: (value: T) => void }) {
  return (
    <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={label} style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
      {options.map((option) => (
        <ChoiceTile key={String(option.value)} label={option.label} selected={value === option.value} minHeight={controlSize.minimumTarget} onPress={() => onChoose(option.value)} />
      ))}
    </View>
  );
}

/** What the screen asks before any map search: the map is drawn anew only when it changes, so a search keeps its view. */
function questionOf(mode: "near" | "place" | null, from: Point | null, reach: number, chosen: Chosen | null) {
  const nearBox = mode === "near" && from ? boxAround(from, REACH_KM[reach]!) : null;
  if (nearBox) return { nearBox, chosenQuestion: boxQuestion(nearBox) };
  const placed = mode === "place" && chosen?.district !== undefined;
  return { nearBox, chosenQuestion: placed ? placeQuestion({ province: chosen.province, district: chosen.district ?? null }) : null };
}

export default function PharmaciesScreen() {
  const [mode, setMode] = useState<"near" | "place" | null>(null);
  const [located, setLocated] = useState<Located>({ status: "idle" });
  const [reach, setReach] = useState(0);
  // What the map was asked to search; any other choice clears it.
  const [shownBox, setShownBox] = useState<Box | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);

  useEffect(() => {
    let live = true;
    void readPlace().then((saved) => {
      if (!live || !saved) return;
      setChosen((current) => current ?? saved);
      setMode((current) => current ?? "place");
    });
    return () => {
      live = false;
    };
  }, []);

  async function locate() {
    setMode("near");
    setShownBox(null);
    setReach(0);
    setLocated({ status: "locating" });
    try {
      const Location = await loadLocation();
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) return setLocated({ status: "denied" });
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      setLocated({ status: "ready", at: { lat: position.coords.latitude, lon: position.coords.longitude } });
    } catch {
      setLocated({ status: "failed" });
    }
  }

  function choose(next: Chosen | null) {
    setShownBox(null);
    setChosen(next);
    if (next?.district !== undefined) void savePlace({ province: next.province, district: next.district });
  }

  const from = located.status === "ready" ? located.at : null;
  const { nearBox, chosenQuestion } = questionOf(mode, from, reach, chosen);
  const asked = shownBox ?? nearBox;

  return (
    <Screen back="/guide" title={tr.pharmacies.title}>
      <Tiles
        label={tr.pharmacies.title}
        options={[
          { value: "near", label: tr.pharmacies.nearMe },
          { value: "place", label: tr.pharmacies.byPlace },
        ]}
        value={mode}
        onChoose={(next) => {
          if (next === "near") return void locate();
          setShownBox(null);
          setMode(next);
        }}
      />
      <Body muted style={{ marginBottom: spacing.md }}>{tr.pharmacies.locationNote}</Body>
      {mode === "near" ? <Locating located={located} onRetry={() => void locate()} /> : null}
      {mode === "place" ? <PlacePicker chosen={chosen} onChoose={choose} /> : null}
      <Results
        question={shownBox ? boxQuestion(shownBox) : chosenQuestion}
        mapKey={chosenQuestion}
        middle={asked && middleOf(asked)}
        from={from}
        onWiden={nearBox && !shownBox && reach < REACH_KM.length - 1 ? () => setReach(reach + 1) : null}
        onSearch={setShownBox}
      />
    </Screen>
  );
}

function Locating({ located, onRetry }: { located: Located; onRetry: () => void }) {
  if (located.status === "locating") return <Body muted>{tr.pharmacies.locating}</Body>;
  if (located.status !== "denied" && located.status !== "failed") return null;
  return (
    <>
      <Notice tone="error" text={located.status === "denied" ? tr.pharmacies.locationDenied : tr.pharmacies.locationFailed} />
      <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
        <Button label={tr.common.retry} variant="secondary" size="sm" onPress={onRetry} />
      </View>
    </>
  );
}

/** A province typed into a filter, then one of its districts; each chosen row, pressed, chooses again. */
function PlacePicker({ chosen, onChoose }: { chosen: Chosen | null; onChoose: (chosen: Chosen | null) => void }) {
  const places = useAnswer("places", pharmacyPlaces);
  const [query, setQuery] = useState("");
  if (places.status === "error") return <ReadFailed queries={[places]} />;
  if (places.status === "loading") return null;
  const all = places.data ?? [];

  if (!chosen) {
    const provinces = [...new Set(all.map((place) => place.province))].filter((province) => fold(province).includes(fold(query)));
    return (
      <>
        <TextField accessibilityLabel={tr.pharmacies.province} placeholder={tr.pharmacies.province} value={query} onChangeText={setQuery} autoCorrect={false} maxLength={40} style={{ marginBottom: spacing.sm }} />
        <Card rows>
          {provinces.map((province) => (
            <ListRow key={province} title={province} chevron onPress={() => onChoose({ province })} />
          ))}
        </Card>
      </>
    );
  }

  const districts = all.filter((place) => place.province === chosen.province);
  return (
    <>
      <Card rows>
        <ListRow title={chosen.province} subtitle={tr.pharmacies.province} chevron onPress={() => onChoose(null)} />
        {chosen.district !== undefined ? (
          <ListRow title={chosen.district ?? tr.pharmacies.noDistrict} subtitle={tr.pharmacies.district} chevron onPress={() => onChoose({ province: chosen.province })} />
        ) : null}
      </Card>
      {chosen.district === undefined ? (
        <>
          <SectionHeader>{tr.pharmacies.district}</SectionHeader>
          <Card rows>
            {districts.map((place) => (
              <ListRow
                key={place.district ?? ""}
                title={place.district ?? tr.pharmacies.noDistrict}
                subtitle={tr.pharmacies.count(place.pharmacies)}
                chevron
                onPress={() => onChoose({ province: place.province, district: place.district })}
              />
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

function Results({
  question,
  mapKey,
  middle,
  from,
  onWiden,
  onSearch,
}: {
  question: string | null;
  mapKey: string | null;
  /** Where the map opens: the box asked about, or else the first pharmacy. */
  middle: Point | null;
  from: Point | null;
  onWiden: (() => void) | null;
  onSearch: (box: Box) => void;
}) {
  const router = useRouter();
  const answer = useAnswer(question, askPharmacies);
  const [query, setQuery] = useState("");
  const [byName, setByName] = useState(false);
  const [onMap, setOnMap] = useState(false);
  if (answer.status === "error") return <ReadFailed queries={[answer]} />;
  // A map search keeps the map and the last list until its answer lands.
  const found = answer.data ?? answer.previous;
  if (!found) return null;

  const shown = pharmaciesShown(found, query, byName ? null : from);
  const opening = middle ?? (shown[0] ? { lat: shown[0].lat, lon: shown[0].lon } : null);
  const open = (pharmacy: Pharmacy) => router.push({ pathname: "/pharmacy/[id]", params: { id: pharmacy.id } });
  const mapped = HAS_MAP && onMap && opening;

  return (
    <>
      {found.length > 0 ? (
        <>
          <TextField accessibilityLabel={tr.pharmacies.filter} placeholder={tr.pharmacies.filter} value={query} onChangeText={setQuery} autoCorrect={false} maxLength={80} style={{ marginBottom: spacing.sm }} />
          <Views sorted={from != null} byName={byName} onByName={setByName} onMap={onMap} onOnMap={setOnMap} />
        </>
      ) : (
        <Body muted>{tr.pharmacies.none}</Body>
      )}
      {mapped ? <PharmacyMap key={mapKey} pharmacies={shown} middle={opening} onOpen={open} onSearch={onSearch} /> : null}
      {found.length > 0 && shown.length === 0 ? <Body muted>{tr.pharmacies.noMatch}</Body> : null}
      {mapped ? null : <PharmacyList shown={shown} from={from} onOpen={open} />}
      {onWiden ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
          <Button label={tr.pharmacies.widen} variant="secondary" size="sm" onPress={onWiden} />
        </View>
      ) : null}
      <Source found={found} />
    </>
  );
}

/** Distance or name, when there is a distance; list or map, where there is a map. */
function Views({ sorted, byName, onByName, onMap, onOnMap }: { sorted: boolean; byName: boolean; onByName: (value: boolean) => void; onMap: boolean; onOnMap: (value: boolean) => void }) {
  return (
    <>
      {sorted ? (
        <Tiles label={tr.pharmacies.sort} options={[{ value: false, label: tr.pharmacies.sortDistance }, { value: true, label: tr.pharmacies.sortName }]} value={byName} onChoose={onByName} />
      ) : null}
      {HAS_MAP ? <Tiles label={tr.pharmacies.view} options={[{ value: false, label: tr.pharmacies.list }, { value: true, label: tr.pharmacies.map }]} value={onMap} onChoose={onOnMap} /> : null}
    </>
  );
}

function PharmacyList({ shown, from, onOpen }: { shown: readonly Pharmacy[]; from: Point | null; onOpen: (pharmacy: Pharmacy) => void }) {
  if (shown.length === 0) return null;
  return (
    <>
      <SectionHeader>{tr.pharmacies.count(shown.length)}</SectionHeader>
      <Card rows>
        {shown.map((pharmacy) => (
          <PharmacyRow key={pharmacy.id} pharmacy={pharmacy} from={from} onPress={() => onOpen(pharmacy)} />
        ))}
      </Card>
    </>
  );
}

/** OpenStreetMap's credit, which its licence asks for, with the day the newest of these was seen. */
function Source({ found }: { found: readonly Pharmacy[] }) {
  const newest = found.reduce((day, pharmacy) => (pharmacy.seenOn > day ? pharmacy.seenOn : day), "");
  return newest ? <Body muted>{tr.pharmacies.source(formatDay(newest))}</Body> : null;
}
