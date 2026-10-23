/**
 * The first-open tour (`docs/TASKS.md` F1.3), Gital's: one short slide per
 * thing Fiala does, each over a drawing of the screen it names, with back,
 * skip and next. It opens once, the first time Durum is shown on this device,
 * and Ayarlar plays it again.
 *
 * It opens for a new account only: a second device, or a cleared browser, of
 * an account whose cabinet already holds boxes must not be introduced to
 * Fiala again. Sign-up waits for the e-mail's code, so the account is new when
 * its first sync here brings no product, read from the database once that sync
 * has finished rather than from a screen's query, which may be behind it. It
 * waits for the launch screen to leave, or it opens over the mark drawing.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Text, View, type DimensionValue } from "react-native";

import { readCabinet } from "../data/cabinet";
import { tr } from "../i18n/tr";
import { kv } from "../services/kv";
import { useModalAccessibility } from "./accessibility";
import { Button, SlideUp, usePulledOnce } from "./components";
import { Actions, DialogShell } from "./dialog";
import { useLaunched } from "./launch";
import { circle, font, motion, personColors, radius, spacing, tour, type, useTheme, type Palette } from "./theme";

const SEEN_KEY = "fiala.tour.seen";
const SLIDES = tr.tour.slides;

/** Mounted on Durum: the one screen every first open reaches. */
export function FirstRunTour() {
  const launched = useLaunched();
  const settled = usePulledOnce() && launched;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!settled) return;
    void (async () => {
      if ((await kv.get(SEEN_KEY)) === "true") return;
      // Remembered, so emptying the cabinet later does not make the account new.
      if ((await readCabinet()).length > 0) return void kv.set(SEEN_KEY, "true");
      setOpen(true);
    })().catch(() => {});
  }, [settled]);
  if (!open) return null;
  return (
    <TourModal
      onClose={() => {
        setOpen(false);
        void kv.set(SEEN_KEY, "true");
      }}
    />
  );
}

export function TourModal({ onClose }: { onClose: () => void }) {
  const { palette, scheme } = useTheme();
  const [step, setStep] = useState(0);
  const titleRef = useModalAccessibility(true, step);
  const slide = SLIDES[step]!;
  const last = step === SLIDES.length - 1;
  return (
    <DialogShell
      title={slide.title}
      titleRef={titleRef}
      onDismiss={onClose}
      lead={
        <SlideUp key={step} distance={motion.travel.rise}>
          <Artwork step={step} palette={palette} people={Object.values(personColors[scheme])} />
        </SlideUp>
      }
    >
      <View accessible accessibilityLabel={`${tr.tour.step(step + 1, SLIDES.length, slide.title)}. ${slide.body}`} accessibilityLiveRegion="polite" style={{ minHeight: tour.text }}>
        <Text style={[type.body, { color: palette.textSecondary }]}>{slide.body}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.lg }}>
        <Text style={[type.small, { color: palette.textSecondary, fontFamily: font.semibold }]}>{`${step + 1} / ${SLIDES.length}`}</Text>
        <View accessible={false} style={{ flexDirection: "row", gap: spacing.xs }}>
          {SLIDES.map((_, at) => (
            <View
              key={at}
              style={{
                width: at === step ? tour.dot.active : tour.dot.width,
                height: tour.line,
                borderRadius: circle(tour.line),
                backgroundColor: at === step ? palette.primary : palette.border,
              }}
            />
          ))}
        </View>
      </View>
      <Actions>
        {step > 0 ? <Button label={tr.tour.back} variant="ghost" size="sm" onPress={() => setStep(step - 1)} /> : null}
        {last ? null : <Button label={tr.tour.skip} variant="ghost" size="sm" onPress={onClose} />}
        <Button label={last ? tr.tour.start : tr.tour.next} size="sm" onPress={() => (last ? onClose() : setStep(step + 1))} />
      </Actions>
    </DialogShell>
  );
}

/** A skeleton line of text: a width, and the ink it stands for. */
function Line({ width, color }: { width: DimensionValue; color: string }) {
  return <View style={{ width, height: tour.line, borderRadius: circle(tour.line), backgroundColor: color }} />;
}

/** A box as Dolabım draws it: the product's tile, its name and what is left, and whose it is. */
function Box({ palette, owner, width, flag }: { palette: Palette; owner: string; width: DimensionValue; flag?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.xs, borderRadius: radius.sm, backgroundColor: palette.surface }}>
      <View style={{ width: tour.block, height: tour.block, borderRadius: radius.sm, backgroundColor: palette.primarySoft }} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Line width={width} color={palette.textSecondary} />
        {flag ? <Line width="30%" color={flag} /> : null}
      </View>
      <View style={{ width: tour.block, height: tour.block, borderRadius: circle(tour.block), backgroundColor: owner }} />
    </View>
  );
}

function Frame({ palette, children }: { palette: Palette; children: ReactNode }) {
  return (
    <View
      accessible={false}
      style={{
        height: tour.art,
        overflow: "hidden",
        borderRadius: radius.lg,
        backgroundColor: palette.surfaceAlt,
        padding: spacing.md,
        justifyContent: "center",
        gap: spacing.xs,
        marginBottom: spacing.lg,
      }}
    >
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: tour.line, backgroundColor: palette.primary }} />
      {children}
    </View>
  );
}

/** The scanner's corners around a code: four L marks, the code a grid of blocks. */
function Scan({ palette }: { palette: Palette }) {
  const corner = (top: boolean, left: boolean) => ({
    position: "absolute" as const,
    width: spacing.md,
    height: spacing.md,
    [top ? "top" : "bottom"]: 0,
    [left ? "left" : "right"]: 0,
    borderColor: palette.primary,
    [top ? "borderTopWidth" : "borderBottomWidth"]: tour.line / 2,
    [left ? "borderLeftWidth" : "borderRightWidth"]: tour.line / 2,
  });
  return (
    <View style={{ width: tour.art / 2, height: tour.art / 2, alignItems: "center", justifyContent: "center" }}>
      {[corner(true, true), corner(true, false), corner(false, true), corner(false, false)].map((style, at) => (
        <View key={at} style={style} />
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", width: tour.block * 2, gap: spacing.xs / 2 }}>
        {[1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1].map((on, at) => (
          <View key={at} style={{ width: (tour.block * 2 - spacing.xs * 1.5) / 4, aspectRatio: 1, borderRadius: spacing.xs / 4, backgroundColor: on ? palette.textStrong : palette.surface }} />
        ))}
      </View>
    </View>
  );
}

function Artwork({ step, palette, people }: { step: number; palette: Palette; people: readonly string[] }) {
  if (step === 0) {
    // Dolabım: boxes, each with its owner's colour.
    return (
      <Frame palette={palette}>
        <Box palette={palette} owner={people[4]!} width="55%" />
        <Box palette={palette} owner={people[0]!} width="40%" />
        <Box palette={palette} owner={people[6]!} width="65%" />
      </Frame>
    );
  }
  if (step === 1) {
    // The code read, and the fields it filled.
    return (
      <Frame palette={palette}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Scan palette={palette} />
          <View style={{ flex: 1, gap: spacing.sm }}>
            {["70%", "45%", "55%"].map((width) => (
              <View key={width} style={{ padding: spacing.xs, borderRadius: radius.sm, backgroundColor: palette.surface }}>
                <Line width={width as DimensionValue} color={palette.textSecondary} />
              </View>
            ))}
          </View>
        </View>
      </Frame>
    );
  }
  if (step === 2) {
    // Durum: what has passed, what is coming, what is running low.
    return (
      <Frame palette={palette}>
        <Box palette={palette} owner={people[4]!} width="50%" flag={palette.error} />
        <Box palette={palette} owner={people[0]!} width="60%" flag={palette.warning} />
        <Box palette={palette} owner={people[6]!} width="35%" flag={palette.textMuted} />
      </Frame>
    );
  }
  // The household: its people, and the boxes they share.
  return (
    <Frame palette={palette}>
      <View style={{ flexDirection: "row", alignSelf: "center", marginBottom: spacing.xs }}>
        {[people[4]!, people[0]!, people[6]!].map((color, at) => (
          <View key={color} style={{ width: tour.mark, height: tour.mark, borderRadius: circle(tour.mark), marginLeft: at === 0 ? 0 : -spacing.sm, borderWidth: tour.line / 2, borderColor: palette.surfaceAlt, backgroundColor: color }} />
        ))}
      </View>
      <View style={{ gap: spacing.xs, padding: spacing.sm, borderRadius: radius.md, backgroundColor: palette.surface }}>
        <Line width="60%" color={palette.textStrong} />
        <Line width="40%" color={palette.textSecondary} />
      </View>
    </Frame>
  );
}
