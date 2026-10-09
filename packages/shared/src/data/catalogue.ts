// Generated from BMU_Hub_Architecture_Prompt.json. Edit the JSON spec, then regenerate.
export const catalogueSeed = {
  "edition": "2026",
  "prices_exclusive_of": "GST",
  "services": [
    {
      "id": "digital_marketing",
      "name": "Digital Marketing",
      "track": "Marketing & Visibility",
      "billing_type": "monthly",
      "tiers": {
        "starter": 25000,
        "growth": 50000,
        "premium": 100000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Ad spend excluded"
    },
    {
      "id": "chatgpt_ads",
      "name": "ChatGPT Ads",
      "track": "Marketing & Visibility",
      "billing_type": "monthly",
      "tiers": {
        "starter": 20000,
        "growth": 40000,
        "premium": 75000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Ad spend excluded; platform access subject to provider availability"
    },
    {
      "id": "seo",
      "name": "SEO",
      "track": "Marketing & Visibility",
      "billing_type": "monthly",
      "tiers": {
        "starter": 15000,
        "growth": 30000,
        "premium": 60000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "gbp",
      "name": "Google Business Profile",
      "track": "Marketing & Visibility",
      "billing_type": "monthly",
      "tiers": {
        "starter": 7500,
        "growth": 15000,
        "premium": 25000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "complete_branding",
      "name": "Complete Branding",
      "track": "Brand & Design",
      "billing_type": "one_time",
      "tiers": {
        "starter": 40000,
        "growth": 75000,
        "premium": 150000
      },
      "premium_is_starting_price": true
    },
    {
      "id": "logo_brand_kit",
      "name": "Logo & Brand Kit",
      "track": "Brand & Design",
      "billing_type": "one_time",
      "tiers": {
        "starter": 15000,
        "growth": 30000,
        "premium": 60000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "graphic_design",
      "name": "Graphic Designing",
      "track": "Brand & Design",
      "billing_type": "monthly",
      "tiers": {
        "starter": 10000,
        "growth": 20000,
        "premium": 40000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "website",
      "name": "Website Design & Development",
      "track": "Web & AI",
      "billing_type": "one_time",
      "tiers": {
        "starter": 25000,
        "growth": 60000,
        "premium": 125000
      },
      "premium_is_starting_price": true,
      "excluded_note": "Domain/hosting/paid plugins excluded"
    },
    {
      "id": "ai_chatbot",
      "name": "AI Chatbots",
      "track": "Web & AI",
      "billing_type": "one_time",
      "tiers": {
        "starter": 10000,
        "growth": 25000,
        "premium": 50000
      },
      "premium_is_starting_price": true,
      "excluded_note": "Platform/API charges excluded"
    },
    {
      "id": "smm",
      "name": "Social Media Management",
      "track": "Social & Personal Brand",
      "billing_type": "monthly",
      "tiers": {
        "starter": 25000,
        "growth": 45000,
        "premium": 65000
      },
      "premium_is_starting_price": false,
      "with_shoot_tiers": {
        "starter": 35000,
        "growth": 55000,
        "premium": 75000,
        "sessions": [
          1,
          2,
          3
        ],
        "session_hours": 6
      }
    },
    {
      "id": "smm_brands",
      "name": "Social Media Management — Brands",
      "track": "Social & Personal Brand",
      "billing_type": "monthly",
      "tiers": {
        "starter": 25000,
        "growth": 45000,
        "premium": 65000
      },
      "premium_is_starting_price": false,
      "with_shoot_tiers": {
        "starter": 35000,
        "growth": 55000,
        "premium": 75000,
        "sessions": [
          1,
          2,
          3
        ],
        "session_hours": 6
      }
    },
    {
      "id": "smm_influencers",
      "name": "Social Media Management — Influencers",
      "track": "Social & Personal Brand",
      "billing_type": "monthly",
      "tiers": {
        "starter": 25000,
        "growth": 45000,
        "premium": 65000
      },
      "premium_is_starting_price": false,
      "with_shoot_tiers": {
        "starter": 35000,
        "growth": 55000,
        "premium": 75000,
        "sessions": [
          1,
          2,
          3
        ],
        "session_hours": 6
      }
    },
    {
      "id": "personal_branding",
      "name": "Personal Branding",
      "track": "Social & Personal Brand",
      "billing_type": "monthly",
      "tiers": {
        "starter": 20000,
        "growth": 40000,
        "premium": 75000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "video_editing",
      "name": "Video Editing",
      "track": "Content & Production",
      "billing_type": "monthly",
      "tiers": {
        "starter": 12000,
        "growth": 25000,
        "premium": 50000
      },
      "premium_is_starting_price": false
    },
    {
      "id": "business_video_shoot",
      "name": "Business Video Shoots",
      "track": "Content & Production",
      "billing_type": "per_unit",
      "tiers": {
        "starter": 12000,
        "growth": 25000,
        "premium": 50000
      },
      "premium_is_starting_price": true,
      "unit": "shoot",
      "excluded_note": "Travel/special equipment may be additional"
    },
    {
      "id": "podcast_shoot",
      "name": "Podcast Shoots",
      "track": "Content & Production",
      "billing_type": "per_unit",
      "tiers": {
        "starter": 15000,
        "growth": 30000,
        "premium": 50000
      },
      "premium_is_starting_price": true,
      "unit": "session (3 hrs)"
    },
    {
      "id": "ugc_content",
      "name": "UGC Content",
      "track": "UGC & Creator Marketing",
      "billing_type": "monthly",
      "tiers": {
        "starter": 15000,
        "growth": 30000,
        "premium": 60000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Creator fees/product shipping may be additional"
    },
    {
      "id": "ugc_ads",
      "name": "UGC Ads",
      "track": "UGC & Creator Marketing",
      "billing_type": "monthly",
      "tiers": {
        "starter": 15000,
        "growth": 30000,
        "premium": 60000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Ad spend + creator fees excluded"
    },
    {
      "id": "ugc_outsourcing",
      "name": "UGC Outsourcing",
      "track": "UGC & Creator Marketing",
      "billing_type": "monthly",
      "tiers": {
        "starter": 10000,
        "growth": 20000,
        "premium": 40000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Creator payments separate"
    },
    {
      "id": "ugc_promotions",
      "name": "UGC Promotions",
      "track": "UGC & Creator Marketing",
      "billing_type": "monthly",
      "tiers": {
        "starter": 25000,
        "growth": 40000,
        "premium": 80000
      },
      "premium_is_starting_price": false,
      "excluded_note": "Creator fees separate"
    },
    {
      "id": "brand_collaborations",
      "name": "Brand Collaborations",
      "track": "UGC & Creator Marketing",
      "billing_type": "per_unit",
      "tiers": {
        "starter": 25000,
        "growth": 40000,
        "premium": 80000
      },
      "premium_is_starting_price": true,
      "unit": "campaign",
      "excluded_note": "Partner/creator fees separate"
    },
    {
      "id": "experiential_ads",
      "name": "Experiential Ads",
      "track": "UGC & Creator Marketing",
      "billing_type": "per_unit",
      "tiers": {
        "starter": 25000,
        "growth": 50000,
        "premium": 100000
      },
      "premium_is_starting_price": true,
      "unit": "campaign",
      "excluded_note": "Actual activation/production costs extra"
    }
  ],
  "bundles": {
    "discount_pct": 10,
    "rule": "Combined value of selected tier across included services less 10%. Social media priced without shoot; shoot-based packages quoted on request.",
    "items": [
      {
        "id": "digital_presence",
        "name": "Digital Presence",
        "services": [
          "website",
          "seo",
          "gbp",
          "smm"
        ]
      },
      {
        "id": "brand_launch",
        "name": "Brand Launch",
        "services": [
          "complete_branding",
          "graphic_design",
          "website"
        ]
      },
      {
        "id": "social_growth",
        "name": "Social Growth",
        "services": [
          "smm",
          "graphic_design",
          "video_editing",
          "ugc_content"
        ]
      },
      {
        "id": "ugc_growth",
        "name": "UGC Growth",
        "services": [
          "ugc_content",
          "ugc_outsourcing",
          "ugc_ads",
          "ugc_promotions"
        ]
      },
      {
        "id": "founder_brand",
        "name": "Founder Brand",
        "services": [
          "personal_branding",
          "business_video_shoot",
          "video_editing",
          "smm"
        ]
      },
      {
        "id": "business_ai",
        "name": "Business AI",
        "services": [
          "ai_chatbot",
          "website",
          "digital_marketing"
        ]
      },
      {
        "id": "local_business_growth",
        "name": "Local Business Growth",
        "services": [
          "gbp",
          "seo",
          "smm",
          "business_video_shoot",
          "graphic_design"
        ]
      },
      {
        "id": "complete_digital_growth",
        "name": "Complete Digital Growth",
        "services": [
          "digital_marketing",
          "seo",
          "complete_branding",
          "website",
          "smm",
          "video_editing",
          "ugc_content",
          "ai_chatbot"
        ]
      }
    ]
  },
  "priced_addons": [
    {
      "name": "Additional platform in a social media package",
      "price": 7000,
      "unit": "each"
    },
    {
      "name": "Additional shoot session (6 hours)",
      "price": 10000
    },
    {
      "name": "Ranking on AI engines (AEO / GEO)",
      "price": 10000
    }
  ],
  "custom_quote_addon_groups": [
    "Content & Creative",
    "Production",
    "Creator & UGC",
    "Web, SEO & AI",
    "Management"
  ],
  "billed_separately": [
    "advertising spend",
    "creator & influencer fees",
    "third-party charges (domain, hosting, plugins, fonts, stock, chatbot platform/API)",
    "production extras (travel outside city, permits, venue, props, models, special equipment)",
    "GST"
  ],
  "payment_terms": {
    "retainer": "billed monthly in advance",
    "project": "50% on confirmation, 50% before final handover"
  },
  "ownership": "Final approved files handed over on completion of payment",
  "deliverables_source": "Load per-tier deliverables from BMU Services & Packages Catalogue 2026"
} as const;
