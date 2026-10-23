/**
 * Yardım (`docs/TASKS.md` F1.31): that the app informs and does not advise,
 * the questions a person asks first, which build is running, and what the
 * app is made from. Feedback stays its own row beside this one in Ayarlar.
 */

import { Text, View } from "react-native";
import Constants from "expo-constants";
import Info from "lucide-react-native/icons/info";

import { tr } from "../i18n/tr";
import { Body, Card, PanelHeader, Screen, SectionHeader } from "../ui/components";
import { OPEN_SOURCE } from "../ui/open-source";
import { font, spacing, type, useTheme } from "../ui/theme";

export default function Help() {
  const { palette } = useTheme();
  // A phone in Expo Go runs a published update, which carries its time; the web and a store build carry none.
  const updated = Constants.manifest2?.createdAt;
  return (
    <Screen back="/settings" title={tr.help.title} width="form">
      <Card>
        <PanelHeader icon={Info} title={tr.help.noticeTitle} />
        <Body>{tr.help.notice}</Body>
      </Card>
      <SectionHeader>{tr.help.faqSection}</SectionHeader>
      <Card>
        {tr.help.faq.map(([question, answer], at) => (
          <View key={question} style={at > 0 ? { marginTop: spacing.md } : undefined}>
            <Text accessibilityRole="header" aria-level={3} style={[type.body, { color: palette.textStrong, fontFamily: font.semibold }]}>
              {question}
            </Text>
            <Body muted>{answer}</Body>
          </View>
        ))}
      </Card>
      <SectionHeader>{tr.help.aboutSection}</SectionHeader>
      <Card>
        <Body>{tr.help.version(Constants.expoConfig?.version ?? "")}</Body>
        {updated ? <Body muted>{tr.help.update(updated)}</Body> : null}
      </Card>
      <SectionHeader>{tr.help.sourcesSection}</SectionHeader>
      <Card>
        <Body>{tr.help.sources}</Body>
        <Body muted style={{ marginTop: spacing.md }}>{tr.help.licensesHint}</Body>
        {Object.entries(OPEN_SOURCE).map(([licence, names]) => (
          <View key={licence} style={{ marginTop: spacing.md }}>
            <Text style={[type.label, { color: palette.textStrong }]}>{licence}</Text>
            <Text style={[type.small, { color: palette.textSecondary }]}>{names.join(", ")}</Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
