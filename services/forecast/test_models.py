import unittest

import models


class Models(unittest.TestCase):
    def test_holt_follows_a_trend(self):
        f = models.holt([100, 110, 120, 130, 140], 2)
        self.assertGreater(f[0], 140)
        self.assertGreater(f[1], f[0])

    def test_revenue_never_below_committed(self):
        r = models.revenue({"history": [500, 400, 300, 200], "committed": [450, 450, 450], "pipeline": [0, 0, 0]})
        self.assertEqual(len(r["expected"]), 3)
        self.assertTrue(all(e >= 450 for e in r["expected"]))
        self.assertTrue(all(lo <= e <= hi for lo, e, hi in zip(r["low"], r["expected"], r["high"])))

    def test_churn_reasons(self):
        r = models.churn({"clients": [{"id": "a", "healthScore": 40, "healthReasons": ["2 overdue invoices", "Quiet for 40 days"], "endsInDays": 10, "activityChangePct": -70, "tenureDays": 400}, {"id": "b", "healthScore": 100, "healthReasons": [], "endsInDays": None, "activityChangePct": None, "tenureDays": 400}]})
        a, b = r["results"]
        self.assertGreater(a["score"], 70)
        self.assertEqual(b["score"], 0)
        self.assertEqual(a["reasons"][0]["label"], "Retainer ends in 10 days with no renewal yet")


if __name__ == "__main__":
    unittest.main()
