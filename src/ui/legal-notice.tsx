/**
 * The KVKK notice, one body in two frames: `src/app/privacy.tsx`, which
 * Ayarlar and feedback link to, and the sheet sign-up opens over its form. A
 * legal text that exists twice will one day say two things, and the copy read
 * before consenting is the worst place for that.
 *
 * Numbered sections, because a notice is cited by section; Article 11's own
 * lettering on the rights; a card per section, so the long sentences come in
 * measured blocks. `tests/ui/legal-notice.test.ts` holds what makes it real.
 */

import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Check from "lucide-react-native/icons/check";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import ShieldCheck from "lucide-react-native/icons/shield-check";
import X from "lucide-react-native/icons/x";

import { tr } from "../i18n/tr";
import { useModalAccessibility } from "./accessibility";
import { Body, Button, Card, PanelHeader, SectionHeader } from "./components";
import { useModalSlot } from "./dialog";
import { selectionTap } from "./haptics";
import { interactionSurface } from "./interaction";
import { useReducedMotion } from "./motion";
import { shouldPresentOptionsAsSheet } from "./responsive";
import { alpha, borderWidth, controlSize, font, legalNotice, offset, radius, spacing, themeShadow, type, useTheme } from "./theme";

/** Article 11's own lettering, so a reader holding the statute lines them up. */
const ARTICLE_11_LETTERS = ["a", "b", "c", "ç", "d", "e", "f", "g"] as const;

/**
 * A leading `**name**` drawn as the name it is: every item is a category and
 * what is done with it, and one grey paragraph of both is what makes a notice
 * unreadable. One marker at the start is all this text uses, so no parser.
 */
function NoticeItem({ text, marker }: { text: string; marker?: string }) {
  const { palette } = useTheme();
  const match = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(text);
  return (
    <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm }}>
      {marker ? <Body muted style={{ minWidth: legalNotice.marker, fontFamily: type.label.fontFamily }}>{`${marker})`}</Body> : null}
      <Body muted style={{ flex: 1 }}>
        {match ? (
          <>
            <Text style={{ color: palette.text, fontFamily: type.label.fontFamily }}>{match[1]}</Text>
            {` ${match[2]}`}
          </>
        ) : (
          text
        )}
      </Body>
    </View>
  );
}

function Section({ title, intro, items, lettered = false }: { title: string; intro?: string; items?: readonly string[]; lettered?: boolean }) {
  return (
    <>
      <SectionHeader>{title}</SectionHeader>
      <Card>
        {intro ? <Body muted style={{ marginBottom: items ? spacing.md : 0 }}>{intro}</Body> : null}
        {items?.map((item, at) => <NoticeItem key={item} text={item} marker={lettered ? ARTICLE_11_LETTERS[at] : undefined} />)}
      </Card>
    </>
  );
}

/** The notice itself, with no opinion about what frames it. */
export function LegalNoticeBody() {
  const { palette } = useTheme();
  const { legal } = tr;
  return (
    <>
      <Card>
        <PanelHeader icon={ShieldCheck} title={legal.subtitle} description={legal.updated} />
        <Body muted>{legal.intro}</Body>
      </Card>
      <Section title={legal.controllerTitle} intro={legal.controllerBody(legal.controllerName, legal.contactEmail)} />
      <Section title={legal.collectedTitle} intro={legal.collectedIntro} items={legal.collected} />
      <Section title={legal.methodTitle} intro={legal.methodBody} />
      <Section title={legal.purposeTitle} items={legal.purposes} />
      <Section title={legal.transferTitle} intro={legal.transferIntro} items={legal.transfers} />
      {/* The way out of the transfer, apart from who receives what: the one
          paragraph here that describes a choice rather than a fact. */}
      <Card>
        <Body>{legal.transferNote}</Body>
      </Card>
      <Section title={legal.retentionTitle} items={legal.retention} />
      <Section title={legal.rightsTitle} intro={legal.rightsIntro} items={legal.rights} lettered />
      <Section title={legal.selfServiceTitle} items={legal.selfService} />
      <Section title={legal.contactTitle} intro={legal.contactBody(legal.contactEmail)} />
      <View style={{ marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: borderWidth.outline, borderTopColor: palette.border }}>
        <Body muted style={{ fontSize: type.small.fontSize }}>{legal.disclaimer}</Body>
      </View>
    </>
  );
}

/**
 * The notice over the form, for sign-up, which must not navigate away: a push
 * would cost what was typed. The scrim is the card's sibling, not its parent,
 * because a pressable around a scroll view swallows the drag that moves it —
 * nested that way, the notice could not be read past its first screen.
 * Acceptance is the last thing in the scroll, where the reading ends: the
 * distance is the mechanism, and nothing measures how far anyone scrolled.
 */
export function LegalNoticeSheet({ onClose, onAccept }: { onClose: () => void; onAccept?: () => void }) {
  const { palette } = useTheme();
  const reducedMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const asSheet = shouldPresentOptionsAsSheet(width);
  const titleRef = useModalAccessibility(true);
  const modal = useModalSlot("sheet");
  return (
    <Modal aria-label={tr.legal.title} transparent animationType={reducedMotion ? "none" : "fade"} visible onRequestClose={onClose} onDismiss={modal.onGone}>
      <View style={{ flex: 1, justifyContent: asSheet ? "flex-end" : "center", padding: asSheet ? 0 : spacing.lg }}>
        <Pressable accessible={false} tabIndex={-1} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]} />
        <View
          accessibilityViewIsModal
          aria-label={tr.legal.title}
          style={{
            alignSelf: "center",
            width: "100%",
            maxWidth: asSheet ? undefined : legalNotice.maxWidth,
            maxHeight: height * (asSheet ? legalNotice.sheetHeightShare : legalNotice.boxHeightShare),
            backgroundColor: palette.background,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderBottomLeftRadius: asSheet ? 0 : radius.lg,
            borderBottomRightRadius: asSheet ? 0 : radius.lg,
            ...themeShadow.overlay(palette),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md }}>
            <View ref={titleRef} accessible accessibilityRole="header" aria-level={2} tabIndex={-1} style={{ flex: 1 }}>
              <Text style={[type.heading, { color: palette.textStrong }]}>{tr.legal.title}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr.common.close}
              onPress={onClose}
              style={(state) => ({
                width: controlSize.minimumTarget,
                height: controlSize.minimumTarget,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.sm,
                ...interactionSurface(palette, state),
              })}
            >
              <X accessible={false} size={legalNotice.closeIcon} color={palette.textSecondary} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }} showsVerticalScrollIndicator={Platform.OS === "web"}>
            <LegalNoticeBody />
            {onAccept ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: false }}
                aria-checked={false}
                accessibilityLabel={tr.legal.consentLabel}
                onPress={() => {
                  selectionTap();
                  onAccept();
                }}
                style={(state) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: spacing.sm,
                  marginTop: spacing.lg,
                  padding: spacing.md,
                  borderRadius: radius.md,
                  borderWidth: borderWidth.control,
                  borderColor: palette.primary,
                  ...interactionSurface(palette, state, { base: palette.surfaceAlt }),
                })}
              >
                <View
                  style={{
                    width: legalNotice.acceptBox,
                    height: legalNotice.acceptBox,
                    marginTop: offset.hair,
                    borderRadius: radius.sm,
                    borderWidth: borderWidth.control,
                    borderColor: palette.primary,
                  }}
                />
                <Text style={[type.small, { flex: 1, color: palette.text }]}>{tr.legal.consentLabel}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg, borderTopWidth: borderWidth.outline, borderTopColor: palette.border }}>
            <Button label={tr.common.close} variant="secondary" onPress={onClose} />
          </View>
        </View>
      </View>
      {modal.slot}
    </Modal>
  );
}

/**
 * The sign-up form's side of consent: one box, in one place, in both states.
 * Pressing it opens the notice whether it was accepted yet or not; accepting
 * happens only at the notice's end, never here. Its error shows only after a
 * refused press, never while the form is being filled.
 */
export function LegalConsentControl({ consented, onOpen, invalid = false }: { consented: boolean; onOpen: () => void; invalid?: boolean }) {
  const { palette } = useTheme();
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consented }}
        aria-checked={consented}
        accessibilityLabel={consented ? tr.legal.consentGiven : tr.legal.consentOpen}
        accessibilityHint={consented ? tr.legal.consentViewHint : tr.legal.consentHint}
        onPress={onOpen}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          minHeight: controlSize.minimumTarget,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderRadius: radius.md,
          borderWidth: borderWidth.control,
          // A box whose state is seen: the tint every finished thing wears,
          // not fourteen pixels of tick.
          borderColor: consented ? palette.success + alpha.doneEdge : invalid ? palette.error : palette.controlBorder,
          ...interactionSurface(palette, state, { base: consented ? palette.success + alpha.selectedTint : undefined }),
        })}
      >
        <View
          accessible={false}
          style={{
            width: legalNotice.box,
            height: legalNotice.box,
            borderRadius: radius.sm,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: consented ? palette.success : "transparent",
            borderWidth: consented ? 0 : borderWidth.control,
            borderColor: invalid ? palette.error : palette.controlBorder,
          }}
        >
          {consented ? <Check accessible={false} size={legalNotice.boxIcon} strokeWidth={legalNotice.boxStroke} color={palette.onPrimary} /> : null}
        </View>
        <Text style={[type.small, { flex: 1, color: consented ? palette.successText : palette.text }]}>{consented ? tr.legal.consentGiven : tr.legal.consentOpen}</Text>
        {consented ? (
          <Text style={[type.small, { color: palette.accentText, fontFamily: font.semibold }]}>{tr.legal.consentView}</Text>
        ) : (
          <ChevronRight accessible={false} size={legalNotice.chevron} color={palette.textSecondary} />
        )}
      </Pressable>
      {invalid && !consented ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.small, { color: palette.errorText, marginTop: spacing.xs }]}>
          {tr.legal.consentRequired}
        </Text>
      ) : null}
    </View>
  );
}
