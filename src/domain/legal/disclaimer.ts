import { tr } from "@/lib/i18n";

/**
 * The one wording of what the app's documents are not. The report, Proof and the apartment
 * passport all print this text, so it is changed here and nowhere else. It must be agreed
 * with a lawyer before a public launch.
 */
export const DISCLAIMER = tr`Отчёт построен по геометрии плана и данным, которые ввёл пользователь. Он не заменяет проект перепланировки и её согласование и не является разрешением на работы. Решения о несущих конструкциях принимает специалист.`;

/** The short form on every page footer. */
export const FOOTER_NOTE = tr`не заменяет проект и согласование`;
