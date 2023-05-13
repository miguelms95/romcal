import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BuiltFile, log, logError, yamlImports } from '@romcal/build';
import {
  CalendarDef,
  CalendarDefConfig,
  CalendarDefInput,
  CalendarId,
  Color,
  DateDef,
  DateDefException,
  DateDefInput,
  DEFAULT_CALENDAR_CONFIG,
  isMartyr,
  isMonthIndex,
  isProperOfTimeId,
  LiturgicalDayDef,
  LiturgicalDayDefInput,
  LiturgicalDayDiff,
  LiturgicalDayId,
  LocaleKey,
  MartyrologyItem,
  MartyrologyItemId,
  MartyrologyMap,
  Precedence,
  ProperCycle,
  Rank,
  RanksFromPrecedence,
  RomcalTitle,
} from '@romcal/shared';
import arrify from 'arrify';
import chalk from 'chalk';
import { getDiff } from 'recursive-diff';

import { inputToManyMartyrologyItems, inputToTitles } from './martyrology.helpers';

export function inputToDateDef(input: DateDefInput | undefined): DateDef | undefined {
  if (typeof input === 'string') {
    const inputArray = input.split('-');
    const month = parseInt(inputArray[0], 10);
    const date = parseInt(inputArray[1], 10);

    if (inputArray.length !== 2 || !isMonthIndex(month)) return undefined;
    return { month, date };
  }

  return input;
}

function getLiturgicalDayDefDiff(
  existingItem: LiturgicalDayDef,
  newItem: LiturgicalDayDef,
): LiturgicalDayDiff {
  const { diff: prevDiff, fromCalendarId: prevCalId, ...existingItemToCompare } = existingItem;
  const { diff: newDiff, fromCalendarId: newCalId, ...newItemToCompare } = newItem;
  return {
    fromCalendarId: prevCalId,
    diff: getDiff(existingItemToCompare, newItemToCompare, true),
  };
}

export function combineLiturgicalDayDefs({
  liturgicalDayId,
  calendarId,
  existingItem,
  input,
  martyrologyCatalog,
}: {
  liturgicalDayId: LiturgicalDayId;
  calendarId: CalendarId;
  existingItem: LiturgicalDayDef | undefined;
  input: LiturgicalDayDefInput;
  martyrologyCatalog: MartyrologyMap;
}): LiturgicalDayDef {
  const dateDef: DateDef | undefined = inputToDateDef(input.dateDef) ?? existingItem?.dateDef;
  if (!isProperOfTimeId(liturgicalDayId) && !dateDef) {
    throw new Error(`Missing dateDef property for ${liturgicalDayId} in ${calendarId}.`);
  }

  const dateExceptions: DateDefException[] | undefined = input.dateExceptions
    ? arrify(input.dateExceptions)
    : existingItem?.dateExceptions;

  const precedence: Precedence | undefined = input.precedence ?? existingItem?.precedence;
  if (!isProperOfTimeId(liturgicalDayId) && !precedence) {
    throw new Error(`Missing precedence property for ${liturgicalDayId} in ${calendarId}.`);
  }

  const rank: Rank | undefined = precedence ? RanksFromPrecedence[precedence] : undefined;

  const allowSimilarRankItems: boolean | undefined =
    input.allowSimilarRankItems ?? existingItem?.allowSimilarRankItems;

  const isHolyDayOfObligation: boolean | undefined =
    input.isHolyDayOfObligation ?? existingItem?.isHolyDayOfObligation;

  const properCycle: ProperCycle | undefined =
    input.properCycle ?? existingItem?.properCycle ?? !isProperOfTimeId(liturgicalDayId)
      ? ProperCycle.ProperOfSaints
      : undefined;

  const customLocaleKey: LocaleKey | undefined =
    input.customLocaleKey ?? existingItem?.customLocaleKey;

  const martyrology: MartyrologyItem[] | undefined = inputToManyMartyrologyItems({
    catalog: martyrologyCatalog,
    allItemsPointers: input.martyrology,
    existingItems: existingItem?.martyrology,
    onMartyrologyItemNotFound: (itemId: MartyrologyItemId) => {
      throw new Error(`Martyrology item ${itemId} not found in ${calendarId}.`);
    },
    onEmptyTitleList: () => {
      throw new Error(
        `The titles property must contain at least one title for ${liturgicalDayId} in ${calendarId}.`,
      );
    },
  });

  const martyrologyTitles: RomcalTitle[] | undefined = martyrology?.reduce<
    RomcalTitle[] | undefined
  >((acc, item) => {
    if (Array.isArray(item.titles)) return [...(acc ?? []), ...item.titles];
    return acc;
  }, undefined);

  const titles: RomcalTitle[] | undefined = inputToTitles({
    existingTitles:
      existingItem?.titles || martyrologyTitles
        ? [...(existingItem?.titles ?? []), ...(martyrologyTitles ?? [])]
        : undefined,
    input: input.titles,
    onEmptyTitleList: () => {
      throw new Error(
        `The titles property must contain at least one title for ${liturgicalDayId} in ${calendarId}.`,
      );
    },
  });

  const colors: Color[] | undefined =
    input.colors ?? existingItem?.colors ?? !isProperOfTimeId(liturgicalDayId)
      ? isMartyr(titles)
        ? [Color.Red]
        : [Color.White]
      : undefined;

  const isOptional: boolean | undefined = input.isOptional ?? existingItem?.isOptional;

  const drop: boolean | undefined = input.drop ?? existingItem?.drop;

  const fromCalendarId: CalendarId = calendarId;

  const newItem: LiturgicalDayDef = {
    liturgicalDayId,
    dateDef,
    dateExceptions,
    precedence,
    rank,
    allowSimilarRankItems,
    isHolyDayOfObligation,
    properCycle,
    customLocaleKey,
    titles,
    colors,
    martyrology,
    isOptional,
    drop,
    fromCalendarId,
  };

  const diff = existingItem
    ? [...(existingItem.diff ?? []), getLiturgicalDayDefDiff(existingItem, newItem)]
    : undefined;

  return { ...newItem, diff };
}

type BuildCalendarsOptions = {
  entryPoints: string;
  martyrology: MartyrologyMap;
  outDir: string;
  onWriteFile?: (opt: BuiltFile) => void;
};

/**
 * Imports the calendars from the specified entry points and returns them as a map of calendar file
 * paths to calendar definitions.
 */
export function getCalendarDefInputs(
  entryPoints: BuildCalendarsOptions['entryPoints'],
): Record<string, CalendarDefInput> {
  return yamlImports<CalendarDefInput>({
    entryPoints,
    getId: (calendarDef) => calendarDef.calendarId,
    onFindDuplicates: (duplicatedIds) => {
      throw new Error(`Duplicated calendar IDs: ${duplicatedIds.join(', ')}`);
    },
  });
}

/**
 * Construct the calendar definition tree, that will be used to merge all configs and inputs.
 */
export function getCalendarDefTree(
  calendar: CalendarDefInput,
  allCalendars: Record<string, CalendarDefInput>,
): CalendarDefInput[] {
  return [
    ...calendar.basedOn.map((cal) => {
      const basedCal = Object.values(allCalendars).find((c) => c.calendarId === cal);
      if (!basedCal)
        throw new Error(`Based-on a missing calendar ${cal} in ${calendar.calendarId}.`);
      return basedCal;
    }),
    calendar,
  ];
}

/**
 *  Combine all configs from the based-on calendars and this proper calendar.
 */
export function combineCalendarConfigs(calendarDefTree: CalendarDefInput[]): CalendarDefConfig {
  return calendarDefTree.reduce<CalendarDefConfig>((acc, cal) => {
    return { ...acc, ...cal.config };
  }, DEFAULT_CALENDAR_CONFIG);
}

/**
 * Combine all inputs from the based-on calendars to this proper calendar.
 */
export function combineCalendarDefinitions(
  calendarDefTree: CalendarDefInput[],
  martyrology: MartyrologyMap,
): LiturgicalDayDef[] {
  // Merge all inputs from the based-on calendars and this proper calendar.
  return calendarDefTree.reduce<LiturgicalDayDef[]>((acc, cal) => {
    Object.keys(cal.inputs).forEach((liturgicalDayId) => {
      const existingItem: LiturgicalDayDef | undefined = acc.find(
        (item) => item.liturgicalDayId === liturgicalDayId,
      );

      const newItem = combineLiturgicalDayDefs({
        liturgicalDayId,
        calendarId: cal.calendarId,
        existingItem,
        input: cal.inputs[liturgicalDayId],
        martyrologyCatalog: martyrology,
      });

      // Update existing item or add a new one.
      acc = existingItem
        ? acc.map((item) => (item.liturgicalDayId === liturgicalDayId ? newItem : item))
        : [...acc, newItem];
    });

    return acc;
  }, []);
}

/**
 * Write the calendar JSON file to the output directory.
 */
export function writeCalendarFile(
  calendarDef: CalendarDef,
  outDir: string,
  onWriteFile?: BuildCalendarsOptions['onWriteFile'],
): void {
  const jsonFileName = `${calendarDef.calendarId.toLowerCase()}.json`;
  const jsonOutPath = path.join(outDir, jsonFileName);
  writeFileSync(jsonOutPath, JSON.stringify(calendarDef), { encoding: 'utf-8' });
  if (onWriteFile) onWriteFile({ outPath: jsonOutPath, namespace: 'json' });
}

export async function buildCalendars({
  entryPoints,
  outDir,
  onWriteFile,
  martyrology,
}: BuildCalendarsOptions): Promise<void> {
  try {
    log({ message: `Building calendars: ${entryPoints}`, namespace: 'json' });

    const allCalendars = getCalendarDefInputs(entryPoints);

    mkdirSync(outDir, { recursive: true });

    await Promise.all(
      Object.entries(allCalendars).map(async ([entryPoint, calendar]) => {
        try {
          const calendarDefTree = getCalendarDefTree(calendar, allCalendars);
          const config = combineCalendarConfigs(calendarDefTree);
          const definitions = combineCalendarDefinitions(calendarDefTree, martyrology);

          const calendarDef: CalendarDef = {
            calendarId: calendar.calendarId,
            calendarTree: [...calendar.basedOn, calendar.calendarId],
            config,
            definitions,
          };

          writeCalendarFile(calendarDef, outDir, onWriteFile);
        } catch (error) {
          error instanceof Error
            ? logError(`${chalk.bold(entryPoint)}: ${error.message}`)
            : logError(`${chalk.bold(entryPoint)}:\n${error}`);
        }
      }),
    );
  } catch (error) {
    error instanceof Error ? logError(error.message) : logError(`${error}`);
  }
}
