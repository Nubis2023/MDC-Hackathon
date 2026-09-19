"""Shared product catalog; recorded counts are separate from device observations."""


CATALOG = {
    "coffee": {"name": "Coffee demonstration box", "price_cents": 1200,
               "category": "drinks", "unit": "box", "reorder_point": 2, "recorded_stock": 1},
    "tea": {"name": "Tea demonstration box", "price_cents": 800,
            "category": "drinks", "unit": "box", "reorder_point": 2, "recorded_stock": 1},
    "water": {"name": "Water", "price_cents": 200,
              "category": "drinks", "unit": "bottle", "reorder_point": 3, "recorded_stock": 8},
    "juice": {"name": "Orange juice", "price_cents": 350,
              "category": "drinks", "unit": "bottle", "reorder_point": 2, "recorded_stock": 5},
    "soda": {"name": "Soda", "price_cents": 250,
             "category": "drinks", "unit": "can", "reorder_point": 2, "recorded_stock": 6},
    "chips": {"name": "Potato chips", "price_cents": 300,
              "category": "snacks", "unit": "bag", "reorder_point": 2, "recorded_stock": 5},
    "cookies": {"name": "Cookies", "price_cents": 400,
                "category": "snacks", "unit": "pack", "reorder_point": 2, "recorded_stock": 4},
    "granola": {"name": "Granola bar", "price_cents": 250,
                "category": "snacks", "unit": "bar", "reorder_point": 2, "recorded_stock": 6},
    "chocolate": {"name": "Chocolate bar", "price_cents": 300,
                  "category": "snacks", "unit": "bar", "reorder_point": 2, "recorded_stock": 4},
    "nuts": {"name": "Mixed nuts", "price_cents": 450,
             "category": "snacks", "unit": "bag", "reorder_point": 2, "recorded_stock": 3},
}

SKU = {"type": "string", "enum": list(CATALOG)}
