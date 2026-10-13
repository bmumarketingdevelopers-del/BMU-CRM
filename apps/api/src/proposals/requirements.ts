// Default requirement checklist per service (modules.requirements in the spec).
// Branch Managers will edit these as ChecklistTemplates; this is the starting set.
const VIDEO_LIKE = ['smm', 'smm_brands', 'smm_influencers', 'personal_branding', 'video_editing', 'business_video_shoot', 'podcast_shoot', 'ugc_content', 'ugc_ads', 'ugc_outsourcing', 'ugc_promotions'];
const NEEDS_ACCESS: Record<string, string> = {
  digital_marketing: 'Meta Business Manager and Google Ads access',
  chatgpt_ads: 'Ads account access',
  seo: 'Google Search Console and Analytics access',
  gbp: 'Google Business Profile manager access',
  website: 'Domain and hosting access',
  ai_chatbot: 'Website admin access',
  smm: 'Social media account access',
  smm_brands: 'Social media account access',
};

export function defaultRequirements(serviceKey: string): { label: string; type: string }[] {
  const items = [
    { label: 'Business details questionnaire', type: 'info' },
    { label: 'Logo, brand guidelines and fonts', type: 'asset' },
  ];
  if (NEEDS_ACCESS[serviceKey]) items.push({ label: NEEDS_ACCESS[serviceKey], type: 'access' });
  if (VIDEO_LIKE.includes(serviceKey)) items.push({ label: 'At least 10 reference videos', type: 'asset' });
  if (serviceKey === 'website') items.push({ label: 'Page content and photos', type: 'asset' });
  return items;
}
