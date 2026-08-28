/**
 * Every country a library can be in, with the international dialling code you
 * need to reach it. Read by the marketing site's application form — a country
 * `<select>` and a dial-code `<select>` beside a phone input that is now
 * required — and by the API when it re-renders that form after a failed
 * submission.
 *
 * THE DIAL MAP IS THE LIST. A country is offered exactly when there is a number
 * you can dial to reach it, which is the only defensible rule for a form that
 * insists on a phone number: an option with no dial code produces a lead nobody
 * can ring, and a lead nobody can ring is lost in silence. That leaves out six
 * officially assigned ISO 3166-1 alpha-2 codes with no telephone administration
 * of their own — AQ, BV, GS, HM, TF, UM — so 243 + 6 is exactly the 249 codes
 * ISO assigns today, which is how `scripts/check-countries.mjs` proves nothing
 * was forgotten. XK (Kosovo) is absent for a different reason: it is a
 * user-assigned code that ICU happens to know, not an assigned one.
 *
 * `dial` is the E.164 COUNTRY code, digits only, no `+`. Every one of the 25
 * North American Numbering Plan members is therefore '1', not '1268'/'1246'/…:
 * the area code belongs to the number the applicant types, exactly as it does
 * for the US and Canada. Eleven dial codes are shared like this; the checker
 * lists each group by hand and fails if a twelfth appears, because an
 * undeclared duplicate is far more likely to be a typo than a discovery.
 *
 * NAMES ARE ICU'S, RESOLVED AT BUILD TIME AND FROZEN HERE.
 * `Intl.DisplayNames` has authoritative Greek and English names, which settles
 * any question of a country being invented or mistranslated in this file — and
 * the Greek half is not a courtesy, it is what the reader of this form actually
 * reads. But CLDR renames countries (Turkey → Türkiye, Swaziland → Eswatini),
 * and the two Node processes that render this form are not the same Node: the
 * static site is built by whoever runs `pnpm --filter @libriant/site build`,
 * while a failed submission is re-rendered inside the digest-pinned
 * `node:26-alpine` of apps/api/Dockerfile. Resolving names at runtime would let
 * those two disagree: the home page offering 'Τσεχία' and the page that comes
 * back after a typo offering 'Τσεχική Δημοκρατία', in a different place in the
 * list — one form showing an applicant two names for the country they already
 * picked, at the moment they are least inclined to try again, and no test
 * anywhere that renders both. Proving the two agree means running the runtime
 * image, which this workstation cannot do, so the names and the two sort orders
 * are committed instead and `pnpm check:countries` re-derives them from ICU and
 * fails on any drift.
 */

/** One country: ISO 3166-1 alpha-2, its E.164 country code, and its name per site language. */
export interface Country {
  readonly code: CountryCode;
  /** E.164 country code, digits only — a renderer supplies the leading `+`. */
  readonly dial: string;
  /** CLDR's Greek name. */
  readonly el: string;
  /** CLDR's English name. */
  readonly en: string;
}

/**
 * The table itself, in ISO-code order — the order that makes a diff on this
 * file reviewable, not the order anyone reads it in. See {@link countriesFor}
 * for that.
 */
const TABLE = [
  { code: 'AD', dial: '376', el: 'Ανδόρα', en: 'Andorra' },
  { code: 'AE', dial: '971', el: 'Ηνωμένα Αραβικά Εμιράτα', en: 'United Arab Emirates' },
  { code: 'AF', dial: '93', el: 'Αφγανιστάν', en: 'Afghanistan' },
  { code: 'AG', dial: '1', el: 'Αντίγκουα και Μπαρμπούντα', en: 'Antigua & Barbuda' },
  { code: 'AI', dial: '1', el: 'Ανγκουίλα', en: 'Anguilla' },
  { code: 'AL', dial: '355', el: 'Αλβανία', en: 'Albania' },
  { code: 'AM', dial: '374', el: 'Αρμενία', en: 'Armenia' },
  { code: 'AO', dial: '244', el: 'Αγκόλα', en: 'Angola' },
  { code: 'AR', dial: '54', el: 'Αργεντινή', en: 'Argentina' },
  { code: 'AS', dial: '1', el: 'Αμερικανική Σαμόα', en: 'American Samoa' },
  { code: 'AT', dial: '43', el: 'Αυστρία', en: 'Austria' },
  { code: 'AU', dial: '61', el: 'Αυστραλία', en: 'Australia' },
  { code: 'AW', dial: '297', el: 'Αρούμπα', en: 'Aruba' },
  { code: 'AX', dial: '358', el: 'Νήσοι Όλαντ', en: 'Åland Islands' },
  { code: 'AZ', dial: '994', el: 'Αζερμπαϊτζάν', en: 'Azerbaijan' },
  { code: 'BA', dial: '387', el: 'Βοσνία - Ερζεγοβίνη', en: 'Bosnia & Herzegovina' },
  { code: 'BB', dial: '1', el: 'Μπαρμπέιντος', en: 'Barbados' },
  { code: 'BD', dial: '880', el: 'Μπανγκλαντές', en: 'Bangladesh' },
  { code: 'BE', dial: '32', el: 'Βέλγιο', en: 'Belgium' },
  { code: 'BF', dial: '226', el: 'Μπουρκίνα Φάσο', en: 'Burkina Faso' },
  { code: 'BG', dial: '359', el: 'Βουλγαρία', en: 'Bulgaria' },
  { code: 'BH', dial: '973', el: 'Μπαχρέιν', en: 'Bahrain' },
  { code: 'BI', dial: '257', el: 'Μπουρούντι', en: 'Burundi' },
  { code: 'BJ', dial: '229', el: 'Μπενίν', en: 'Benin' },
  { code: 'BL', dial: '590', el: 'Άγιος Βαρθολομαίος', en: 'St. Barthélemy' },
  { code: 'BM', dial: '1', el: 'Βερμούδες', en: 'Bermuda' },
  { code: 'BN', dial: '673', el: 'Μπρουνέι', en: 'Brunei' },
  { code: 'BO', dial: '591', el: 'Βολιβία', en: 'Bolivia' },
  { code: 'BQ', dial: '599', el: 'Ολλανδία Καραϊβικής', en: 'Caribbean Netherlands' },
  { code: 'BR', dial: '55', el: 'Βραζιλία', en: 'Brazil' },
  { code: 'BS', dial: '1', el: 'Μπαχάμες', en: 'Bahamas' },
  { code: 'BT', dial: '975', el: 'Μπουτάν', en: 'Bhutan' },
  { code: 'BW', dial: '267', el: 'Μποτσουάνα', en: 'Botswana' },
  { code: 'BY', dial: '375', el: 'Λευκορωσία', en: 'Belarus' },
  { code: 'BZ', dial: '501', el: 'Μπελίζ', en: 'Belize' },
  { code: 'CA', dial: '1', el: 'Καναδάς', en: 'Canada' },
  { code: 'CC', dial: '61', el: 'Νήσοι Κόκος (Κίλινγκ)', en: 'Cocos (Keeling) Islands' },
  { code: 'CD', dial: '243', el: 'Κονγκό - Κινσάσα', en: 'Congo - Kinshasa' },
  { code: 'CF', dial: '236', el: 'Κεντροαφρικανική Δημοκρατία', en: 'Central African Republic' },
  { code: 'CG', dial: '242', el: 'Κονγκό - Μπραζαβίλ', en: 'Congo - Brazzaville' },
  { code: 'CH', dial: '41', el: 'Ελβετία', en: 'Switzerland' },
  { code: 'CI', dial: '225', el: 'Ακτή Ελεφαντοστού', en: 'Côte d’Ivoire' },
  { code: 'CK', dial: '682', el: 'Νήσοι Κουκ', en: 'Cook Islands' },
  { code: 'CL', dial: '56', el: 'Χιλή', en: 'Chile' },
  { code: 'CM', dial: '237', el: 'Καμερούν', en: 'Cameroon' },
  { code: 'CN', dial: '86', el: 'Κίνα', en: 'China' },
  { code: 'CO', dial: '57', el: 'Κολομβία', en: 'Colombia' },
  { code: 'CR', dial: '506', el: 'Κόστα Ρίκα', en: 'Costa Rica' },
  { code: 'CU', dial: '53', el: 'Κούβα', en: 'Cuba' },
  { code: 'CV', dial: '238', el: 'Πράσινο Ακρωτήριο', en: 'Cape Verde' },
  { code: 'CW', dial: '599', el: 'Κουρασάο', en: 'Curaçao' },
  { code: 'CX', dial: '61', el: 'Νήσος των Χριστουγέννων', en: 'Christmas Island' },
  { code: 'CY', dial: '357', el: 'Κύπρος', en: 'Cyprus' },
  { code: 'CZ', dial: '420', el: 'Τσεχία', en: 'Czechia' },
  { code: 'DE', dial: '49', el: 'Γερμανία', en: 'Germany' },
  { code: 'DJ', dial: '253', el: 'Τζιμπουτί', en: 'Djibouti' },
  { code: 'DK', dial: '45', el: 'Δανία', en: 'Denmark' },
  { code: 'DM', dial: '1', el: 'Ντομίνικα', en: 'Dominica' },
  { code: 'DO', dial: '1', el: 'Δομινικανή Δημοκρατία', en: 'Dominican Republic' },
  { code: 'DZ', dial: '213', el: 'Αλγερία', en: 'Algeria' },
  { code: 'EC', dial: '593', el: 'Ισημερινός', en: 'Ecuador' },
  { code: 'EE', dial: '372', el: 'Εσθονία', en: 'Estonia' },
  { code: 'EG', dial: '20', el: 'Αίγυπτος', en: 'Egypt' },
  { code: 'EH', dial: '212', el: 'Δυτική Σαχάρα', en: 'Western Sahara' },
  { code: 'ER', dial: '291', el: 'Ερυθραία', en: 'Eritrea' },
  { code: 'ES', dial: '34', el: 'Ισπανία', en: 'Spain' },
  { code: 'ET', dial: '251', el: 'Αιθιοπία', en: 'Ethiopia' },
  { code: 'FI', dial: '358', el: 'Φινλανδία', en: 'Finland' },
  { code: 'FJ', dial: '679', el: 'Φίτζι', en: 'Fiji' },
  { code: 'FK', dial: '500', el: 'Νήσοι Φόκλαντ', en: 'Falkland Islands' },
  { code: 'FM', dial: '691', el: 'Μικρονησία', en: 'Micronesia' },
  { code: 'FO', dial: '298', el: 'Νήσοι Φερόες', en: 'Faroe Islands' },
  { code: 'FR', dial: '33', el: 'Γαλλία', en: 'France' },
  { code: 'GA', dial: '241', el: 'Γκαμπόν', en: 'Gabon' },
  { code: 'GB', dial: '44', el: 'Ηνωμένο Βασίλειο', en: 'United Kingdom' },
  { code: 'GD', dial: '1', el: 'Γρενάδα', en: 'Grenada' },
  { code: 'GE', dial: '995', el: 'Γεωργία', en: 'Georgia' },
  { code: 'GF', dial: '594', el: 'Γαλλική Γουιάνα', en: 'French Guiana' },
  { code: 'GG', dial: '44', el: 'Γκέρνζι', en: 'Guernsey' },
  { code: 'GH', dial: '233', el: 'Γκάνα', en: 'Ghana' },
  { code: 'GI', dial: '350', el: 'Γιβραλτάρ', en: 'Gibraltar' },
  { code: 'GL', dial: '299', el: 'Γροιλανδία', en: 'Greenland' },
  { code: 'GM', dial: '220', el: 'Γκάμπια', en: 'Gambia' },
  { code: 'GN', dial: '224', el: 'Γουινέα', en: 'Guinea' },
  { code: 'GP', dial: '590', el: 'Γουαδελούπη', en: 'Guadeloupe' },
  { code: 'GQ', dial: '240', el: 'Ισημερινή Γουινέα', en: 'Equatorial Guinea' },
  { code: 'GR', dial: '30', el: 'Ελλάδα', en: 'Greece' },
  { code: 'GT', dial: '502', el: 'Γουατεμάλα', en: 'Guatemala' },
  { code: 'GU', dial: '1', el: 'Γκουάμ', en: 'Guam' },
  { code: 'GW', dial: '245', el: 'Γουινέα Μπισάου', en: 'Guinea-Bissau' },
  { code: 'GY', dial: '592', el: 'Γουιάνα', en: 'Guyana' },
  { code: 'HK', dial: '852', el: 'Χονγκ Κονγκ ΕΔΠ Κίνας', en: 'Hong Kong SAR China' },
  { code: 'HN', dial: '504', el: 'Ονδούρα', en: 'Honduras' },
  { code: 'HR', dial: '385', el: 'Κροατία', en: 'Croatia' },
  { code: 'HT', dial: '509', el: 'Αϊτή', en: 'Haiti' },
  { code: 'HU', dial: '36', el: 'Ουγγαρία', en: 'Hungary' },
  { code: 'ID', dial: '62', el: 'Ινδονησία', en: 'Indonesia' },
  { code: 'IE', dial: '353', el: 'Ιρλανδία', en: 'Ireland' },
  { code: 'IL', dial: '972', el: 'Ισραήλ', en: 'Israel' },
  { code: 'IM', dial: '44', el: 'Νήσος του Μαν', en: 'Isle of Man' },
  { code: 'IN', dial: '91', el: 'Ινδία', en: 'India' },
  {
    code: 'IO',
    dial: '246',
    el: 'Βρετανικά Εδάφη Ινδικού Ωκεανού',
    en: 'British Indian Ocean Territory',
  },
  { code: 'IQ', dial: '964', el: 'Ιράκ', en: 'Iraq' },
  { code: 'IR', dial: '98', el: 'Ιράν', en: 'Iran' },
  { code: 'IS', dial: '354', el: 'Ισλανδία', en: 'Iceland' },
  { code: 'IT', dial: '39', el: 'Ιταλία', en: 'Italy' },
  { code: 'JE', dial: '44', el: 'Τζέρζι', en: 'Jersey' },
  { code: 'JM', dial: '1', el: 'Τζαμάικα', en: 'Jamaica' },
  { code: 'JO', dial: '962', el: 'Ιορδανία', en: 'Jordan' },
  { code: 'JP', dial: '81', el: 'Ιαπωνία', en: 'Japan' },
  { code: 'KE', dial: '254', el: 'Κένυα', en: 'Kenya' },
  { code: 'KG', dial: '996', el: 'Κιργιστάν', en: 'Kyrgyzstan' },
  { code: 'KH', dial: '855', el: 'Καμπότζη', en: 'Cambodia' },
  { code: 'KI', dial: '686', el: 'Κιριμπάτι', en: 'Kiribati' },
  { code: 'KM', dial: '269', el: 'Κομόρες', en: 'Comoros' },
  { code: 'KN', dial: '1', el: 'Σεν Κιτς και Νέβις', en: 'St. Kitts & Nevis' },
  { code: 'KP', dial: '850', el: 'Βόρεια Κορέα', en: 'North Korea' },
  { code: 'KR', dial: '82', el: 'Νότια Κορέα', en: 'South Korea' },
  { code: 'KW', dial: '965', el: 'Κουβέιτ', en: 'Kuwait' },
  { code: 'KY', dial: '1', el: 'Νήσοι Κέιμαν', en: 'Cayman Islands' },
  { code: 'KZ', dial: '7', el: 'Καζακστάν', en: 'Kazakhstan' },
  { code: 'LA', dial: '856', el: 'Λάος', en: 'Laos' },
  { code: 'LB', dial: '961', el: 'Λίβανος', en: 'Lebanon' },
  { code: 'LC', dial: '1', el: 'Αγία Λουκία', en: 'St. Lucia' },
  { code: 'LI', dial: '423', el: 'Λιχτενστάιν', en: 'Liechtenstein' },
  { code: 'LK', dial: '94', el: 'Σρι Λάνκα', en: 'Sri Lanka' },
  { code: 'LR', dial: '231', el: 'Λιβερία', en: 'Liberia' },
  { code: 'LS', dial: '266', el: 'Λεσότο', en: 'Lesotho' },
  { code: 'LT', dial: '370', el: 'Λιθουανία', en: 'Lithuania' },
  { code: 'LU', dial: '352', el: 'Λουξεμβούργο', en: 'Luxembourg' },
  { code: 'LV', dial: '371', el: 'Λετονία', en: 'Latvia' },
  { code: 'LY', dial: '218', el: 'Λιβύη', en: 'Libya' },
  { code: 'MA', dial: '212', el: 'Μαρόκο', en: 'Morocco' },
  { code: 'MC', dial: '377', el: 'Μονακό', en: 'Monaco' },
  { code: 'MD', dial: '373', el: 'Μολδαβία', en: 'Moldova' },
  { code: 'ME', dial: '382', el: 'Μαυροβούνιο', en: 'Montenegro' },
  { code: 'MF', dial: '590', el: 'Άγιος Μαρτίνος (Γαλλικό τμήμα)', en: 'St. Martin' },
  { code: 'MG', dial: '261', el: 'Μαδαγασκάρη', en: 'Madagascar' },
  { code: 'MH', dial: '692', el: 'Νήσοι Μάρσαλ', en: 'Marshall Islands' },
  { code: 'MK', dial: '389', el: 'Βόρεια Μακεδονία', en: 'North Macedonia' },
  { code: 'ML', dial: '223', el: 'Μάλι', en: 'Mali' },
  { code: 'MM', dial: '95', el: 'Μιανμάρ (Βιρμανία)', en: 'Myanmar (Burma)' },
  { code: 'MN', dial: '976', el: 'Μογγολία', en: 'Mongolia' },
  { code: 'MO', dial: '853', el: 'Μακάο ΕΔΠ Κίνας', en: 'Macao SAR China' },
  { code: 'MP', dial: '1', el: 'Νήσοι Βόρειες Μαριάνες', en: 'Northern Mariana Islands' },
  { code: 'MQ', dial: '596', el: 'Μαρτινίκα', en: 'Martinique' },
  { code: 'MR', dial: '222', el: 'Μαυριτανία', en: 'Mauritania' },
  { code: 'MS', dial: '1', el: 'Μονσεράτ', en: 'Montserrat' },
  { code: 'MT', dial: '356', el: 'Μάλτα', en: 'Malta' },
  { code: 'MU', dial: '230', el: 'Μαυρίκιος', en: 'Mauritius' },
  { code: 'MV', dial: '960', el: 'Μαλδίβες', en: 'Maldives' },
  { code: 'MW', dial: '265', el: 'Μαλάουι', en: 'Malawi' },
  { code: 'MX', dial: '52', el: 'Μεξικό', en: 'Mexico' },
  { code: 'MY', dial: '60', el: 'Μαλαισία', en: 'Malaysia' },
  { code: 'MZ', dial: '258', el: 'Μοζαμβίκη', en: 'Mozambique' },
  { code: 'NA', dial: '264', el: 'Ναμίμπια', en: 'Namibia' },
  { code: 'NC', dial: '687', el: 'Νέα Καληδονία', en: 'New Caledonia' },
  { code: 'NE', dial: '227', el: 'Νίγηρας', en: 'Niger' },
  { code: 'NF', dial: '672', el: 'Νήσος Νόρφολκ', en: 'Norfolk Island' },
  { code: 'NG', dial: '234', el: 'Νιγηρία', en: 'Nigeria' },
  { code: 'NI', dial: '505', el: 'Νικαράγουα', en: 'Nicaragua' },
  { code: 'NL', dial: '31', el: 'Κάτω Χώρες', en: 'Netherlands' },
  { code: 'NO', dial: '47', el: 'Νορβηγία', en: 'Norway' },
  { code: 'NP', dial: '977', el: 'Νεπάλ', en: 'Nepal' },
  { code: 'NR', dial: '674', el: 'Ναουρού', en: 'Nauru' },
  { code: 'NU', dial: '683', el: 'Νιούε', en: 'Niue' },
  { code: 'NZ', dial: '64', el: 'Νέα Ζηλανδία', en: 'New Zealand' },
  { code: 'OM', dial: '968', el: 'Ομάν', en: 'Oman' },
  { code: 'PA', dial: '507', el: 'Παναμάς', en: 'Panama' },
  { code: 'PE', dial: '51', el: 'Περού', en: 'Peru' },
  { code: 'PF', dial: '689', el: 'Γαλλική Πολυνησία', en: 'French Polynesia' },
  { code: 'PG', dial: '675', el: 'Παπούα Νέα Γουινέα', en: 'Papua New Guinea' },
  { code: 'PH', dial: '63', el: 'Φιλιππίνες', en: 'Philippines' },
  { code: 'PK', dial: '92', el: 'Πακιστάν', en: 'Pakistan' },
  { code: 'PL', dial: '48', el: 'Πολωνία', en: 'Poland' },
  { code: 'PM', dial: '508', el: 'Σεν Πιερ και Μικελόν', en: 'St. Pierre & Miquelon' },
  { code: 'PN', dial: '64', el: 'Νήσοι Πίτκερν', en: 'Pitcairn Islands' },
  { code: 'PR', dial: '1', el: 'Πουέρτο Ρίκο', en: 'Puerto Rico' },
  { code: 'PS', dial: '970', el: 'Παλαιστινιακά Εδάφη', en: 'Palestinian Territories' },
  { code: 'PT', dial: '351', el: 'Πορτογαλία', en: 'Portugal' },
  { code: 'PW', dial: '680', el: 'Παλάου', en: 'Palau' },
  { code: 'PY', dial: '595', el: 'Παραγουάη', en: 'Paraguay' },
  { code: 'QA', dial: '974', el: 'Κατάρ', en: 'Qatar' },
  { code: 'RE', dial: '262', el: 'Ρεϊνιόν', en: 'Réunion' },
  { code: 'RO', dial: '40', el: 'Ρουμανία', en: 'Romania' },
  { code: 'RS', dial: '381', el: 'Σερβία', en: 'Serbia' },
  { code: 'RU', dial: '7', el: 'Ρωσία', en: 'Russia' },
  { code: 'RW', dial: '250', el: 'Ρουάντα', en: 'Rwanda' },
  { code: 'SA', dial: '966', el: 'Σαουδική Αραβία', en: 'Saudi Arabia' },
  { code: 'SB', dial: '677', el: 'Νήσοι Σολομώντος', en: 'Solomon Islands' },
  { code: 'SC', dial: '248', el: 'Σεϋχέλλες', en: 'Seychelles' },
  { code: 'SD', dial: '249', el: 'Σουδάν', en: 'Sudan' },
  { code: 'SE', dial: '46', el: 'Σουηδία', en: 'Sweden' },
  { code: 'SG', dial: '65', el: 'Σιγκαπούρη', en: 'Singapore' },
  { code: 'SH', dial: '290', el: 'Αγία Ελένη', en: 'St. Helena' },
  { code: 'SI', dial: '386', el: 'Σλοβενία', en: 'Slovenia' },
  { code: 'SJ', dial: '47', el: 'Σβάλμπαρντ και Γιαν Μαγιέν', en: 'Svalbard & Jan Mayen' },
  { code: 'SK', dial: '421', el: 'Σλοβακία', en: 'Slovakia' },
  { code: 'SL', dial: '232', el: 'Σιέρα Λεόνε', en: 'Sierra Leone' },
  { code: 'SM', dial: '378', el: 'Άγιος Μαρίνος', en: 'San Marino' },
  { code: 'SN', dial: '221', el: 'Σενεγάλη', en: 'Senegal' },
  { code: 'SO', dial: '252', el: 'Σομαλία', en: 'Somalia' },
  { code: 'SR', dial: '597', el: 'Σουρινάμ', en: 'Suriname' },
  { code: 'SS', dial: '211', el: 'Νότιο Σουδάν', en: 'South Sudan' },
  { code: 'ST', dial: '239', el: 'Σάο Τομέ και Πρίνσιπε', en: 'São Tomé & Príncipe' },
  { code: 'SV', dial: '503', el: 'Ελ Σαλβαδόρ', en: 'El Salvador' },
  { code: 'SX', dial: '1', el: 'Άγιος Μαρτίνος (Ολλανδικό τμήμα)', en: 'Sint Maarten' },
  { code: 'SY', dial: '963', el: 'Συρία', en: 'Syria' },
  { code: 'SZ', dial: '268', el: 'Εσουατίνι', en: 'Eswatini' },
  { code: 'TC', dial: '1', el: 'Νήσοι Τερκς και Κάικος', en: 'Turks & Caicos Islands' },
  { code: 'TD', dial: '235', el: 'Τσαντ', en: 'Chad' },
  { code: 'TG', dial: '228', el: 'Τόγκο', en: 'Togo' },
  { code: 'TH', dial: '66', el: 'Ταϊλάνδη', en: 'Thailand' },
  { code: 'TJ', dial: '992', el: 'Τατζικιστάν', en: 'Tajikistan' },
  { code: 'TK', dial: '690', el: 'Τοκελάου', en: 'Tokelau' },
  { code: 'TL', dial: '670', el: 'Τιμόρ-Λέστε', en: 'Timor-Leste' },
  { code: 'TM', dial: '993', el: 'Τουρκμενιστάν', en: 'Turkmenistan' },
  { code: 'TN', dial: '216', el: 'Τυνησία', en: 'Tunisia' },
  { code: 'TO', dial: '676', el: 'Τόνγκα', en: 'Tonga' },
  { code: 'TR', dial: '90', el: 'Τουρκία', en: 'Türkiye' },
  { code: 'TT', dial: '1', el: 'Τρινιντάντ και Τομπάγκο', en: 'Trinidad & Tobago' },
  { code: 'TV', dial: '688', el: 'Τουβαλού', en: 'Tuvalu' },
  { code: 'TW', dial: '886', el: 'Ταϊβάν', en: 'Taiwan' },
  { code: 'TZ', dial: '255', el: 'Τανζανία', en: 'Tanzania' },
  { code: 'UA', dial: '380', el: 'Ουκρανία', en: 'Ukraine' },
  { code: 'UG', dial: '256', el: 'Ουγκάντα', en: 'Uganda' },
  { code: 'US', dial: '1', el: 'Ηνωμένες Πολιτείες', en: 'United States' },
  { code: 'UY', dial: '598', el: 'Ουρουγουάη', en: 'Uruguay' },
  { code: 'UZ', dial: '998', el: 'Ουζμπεκιστάν', en: 'Uzbekistan' },
  { code: 'VA', dial: '39', el: 'Βατικανό', en: 'Vatican City' },
  { code: 'VC', dial: '1', el: 'Άγιος Βικέντιος και Γρεναδίνες', en: 'St. Vincent & Grenadines' },
  { code: 'VE', dial: '58', el: 'Βενεζουέλα', en: 'Venezuela' },
  { code: 'VG', dial: '1', el: 'Βρετανικές Παρθένες Νήσοι', en: 'British Virgin Islands' },
  { code: 'VI', dial: '1', el: 'Αμερικανικές Παρθένες Νήσοι', en: 'U.S. Virgin Islands' },
  { code: 'VN', dial: '84', el: 'Βιετνάμ', en: 'Vietnam' },
  { code: 'VU', dial: '678', el: 'Βανουάτου', en: 'Vanuatu' },
  { code: 'WF', dial: '681', el: 'Γουάλις και Φουτούνα', en: 'Wallis & Futuna' },
  { code: 'WS', dial: '685', el: 'Σαμόα', en: 'Samoa' },
  { code: 'YE', dial: '967', el: 'Υεμένη', en: 'Yemen' },
  { code: 'YT', dial: '262', el: 'Μαγιότ', en: 'Mayotte' },
  { code: 'ZA', dial: '27', el: 'Νότια Αφρική', en: 'South Africa' },
  { code: 'ZM', dial: '260', el: 'Ζάμπια', en: 'Zambia' },
  { code: 'ZW', dial: '263', el: 'Ζιμπάμπουε', en: 'Zimbabwe' },
] as const;

export type CountryCode = (typeof TABLE)[number]['code'];

export const COUNTRIES: readonly Country[] = TABLE;

const BY_CODE = new Map<string, Country>(COUNTRIES.map((c) => [c.code, c]));

/**
 * Whitespace-separated codes rather than two 243-element arrays: prettier puts
 * one element per line, and the exploded arrays bury the table above them under
 * 486 lines of noise. `scripts/check-countries.mjs` asserts each list is a
 * permutation of the table, so a code fat-fingered in here cannot survive — and
 * the strings stay plain data, never narrowed to {@link CountryCode} by an
 * assertion that would claim more than has been checked.
 */
const codes = (list: string): readonly string[] => list.trim().split(/\s+/);

/**
 * Display order per language, ICU's own collation, frozen with the names.
 *
 * Greek and Latin script collate differently and neither list is a rotation of
 * the other — 'Ελλάδα' sorts under Ε, 'Greece' under G, 'Åland Islands' under A
 * — so a single fixed order cannot be right for both languages, and picking one
 * would leave the other locale's dropdown in an order its reader cannot scan.
 */
const ORDER: Record<'el' | 'en', readonly string[]> = {
  el: codes(`
  SH LC BL VC SM MF SX AO AZ EG ET HT CI AL DZ VI AS AI AD AG AR AM AW AU
  AT AF VU VA BE VE BM VN BO KP MK BA BG BR IO VG FR GF PF DE GE GI GM GA
  GH GG GU GP WF GT GY GN GW GD GL DK DO EH SV CH GR ER EE SZ ZM ZW AE US
  GB JP IN ID JO IQ IR IE GQ EC IS ES IL IT KZ CM KH CA QA NL CF KE CN KG
  KI CO KM CD CG CR CU KW CW HR CY LA LS LV BY LB LR LY LT LI LU YT MG MO
  MY MW MV ML MT MA MQ MU MR ME MX MM FM MN MZ MD MC MS BD BB BS BH BZ BJ
  BW BF BI BT BN NA NR NZ NC NP MP KY CC CK MH AX PN SB TC FO FK NF IM CX
  NE NG NI NU NO ZA KR SS DM BQ OM HN HU UG UZ UA UY PK PS PW PA PG PY PE
  PL PT PR CV RE RW RO RU WS ST SA SJ KN PM SN RS SC SG SL SK SI SO SD SE
  SR LK SY TW TH TZ TJ JM JE DJ TL TG TK TO TV TR TM TT TD CZ TN YE PH FI
  FJ CL HK
`),
  en: codes(`
  AF AX AL DZ AS AD AO AI AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM
  BT BO BA BW BR IO VG BN BG BF BI KH CM CA CV BQ KY CF TD CL CN CX CC CO
  KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK
  FO FJ FI FR GF PF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HN
  HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KW KG LA LV LB LS
  LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS
  MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF KP MK MP NO OM PK PW PS PA PG
  PY PE PH PN PL PT PR QA RE RO RU RW WS SM ST SA SN RS SC SL SG SX SK SI
  SB SO ZA KR SS ES LK BL SH KN LC MF PM VC SD SR SJ SE CH SY TW TJ TZ TH
  TL TG TK TO TT TN TR TM TC TV VI UG UA AE GB US UY UZ VU VA VE VN WF EH
  YE ZM ZW
`),
};

/**
 * Pinned to the top of the dropdown, ahead of the alphabet.
 *
 * The site ships zero JavaScript, so this is a native `<select>` with no
 * type-ahead box and no combobox behind it: a Greek municipal library scrolls
 * 243 options to reach the one answer this launch campaign expects from
 * effectively all of them. Greece first and Cyprus second is the entire
 * ergonomics budget the control has.
 */
export const PRIORITY_COUNTRY_CODES: readonly CountryCode[] = ['GR', 'CY'];

/**
 * Greece — the answer for effectively every library this funnel exists for. A
 * renderer that would rather the visitor chose deliberately can lead with an
 * empty option instead; `country` is required either way and the API validates
 * the submitted code with {@link isCountryCode} regardless of what was
 * preselected.
 */
export const DEFAULT_COUNTRY_CODE: CountryCode = 'GR';

const ORDERED: Partial<Record<'el' | 'en', readonly Country[]>> = {};

/**
 * Every country once, in the order this language should show them: the pinned
 * pair, then the rest alphabetically for that language.
 *
 * Each country appears exactly once — the pinned pair is NOT repeated further
 * down. Repeating it is the usual trick for keeping the alphabet intact, but it
 * needs two `<optgroup>` labels to stop the repeat reading as a bug, and this
 * form cannot count on the renderer using them. The split is still available to
 * one that does: the first `PRIORITY_COUNTRY_CODES.length` entries are the
 * pinned pair.
 */
export function countriesFor(lang: 'el' | 'en'): readonly Country[] {
  const cached = ORDERED[lang];
  if (cached) return cached;

  const pinned = new Set<string>(PRIORITY_COUNTRY_CODES);
  const list: Country[] = [];
  for (const code of [...PRIORITY_COUNTRY_CODES, ...ORDER[lang].filter((c) => !pinned.has(c))]) {
    const country = BY_CODE.get(code);
    if (country) list.push(country);
  }
  ORDERED[lang] = list;
  return list;
}

/** The country a submitted code names, or undefined if it names none. */
export function findCountry(code: string): Country | undefined {
  return BY_CODE.get(code);
}

/** Narrows an untrusted string — what the API validates a submitted `country` with. */
export function isCountryCode(v: unknown): v is CountryCode {
  return typeof v === 'string' && BY_CODE.has(v);
}
