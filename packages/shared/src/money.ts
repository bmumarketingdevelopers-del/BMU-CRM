// Money is stored as integer paise (data_model.rules). Catalogue prices are in rupees, exclusive of GST.
export const GST_RATE = 0.18;

export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);
export const paiseToRupees = (paise: number): number => paise / 100;

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** Formats paise in Indian number format, e.g. 10000000 -> "₹1,00,000". */
export const formatINR = (paise: number): string => inr.format(paiseToRupees(paise));

/** GST is always shown separately on top of the GST-exclusive amount. */
export function withGst(netPaise: number) {
  const gst = Math.round(netPaise * GST_RATE);
  return { net: netPaise, gst, total: netPaise + gst };
}
