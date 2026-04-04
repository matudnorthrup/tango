# atlas_sql

Direct SQL access to the Atlas ingredient SQLite database.

## Input

```json
{
  "sql": "SELECT * FROM ingredients WHERE name LIKE '%yogurt%';"
}
```

## Schema

```sql
ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT,
  brand TEXT,
  product TEXT,
  food_id INTEGER,
  serving_id INTEGER,
  serving_description TEXT,
  serving_size TEXT,
  grams_per_serving REAL,
  calories REAL,
  protein REAL,
  carbs REAL,
  fat REAL,
  fiber REAL,
  store TEXT,
  aliases TEXT,
  tags TEXT,
  notes TEXT,
  meta TEXT,
  created_at TEXT,
  updated_at TEXT
)
```

Notes:
- `aliases`, `tags`, and `meta` are JSON stored as text.
- Common indexes: `name`, `food_id`, `brand`, `store`.
- `grams_per_serving` is the conversion anchor for FatSecret diary logging.

## Safety

- `DROP`, `ALTER`, `CREATE`, and `TRUNCATE` are blocked.

## Examples

```sql
SELECT * FROM ingredients
WHERE name LIKE '%chicken%' OR aliases LIKE '%chicken%';
```

```sql
SELECT food_id, serving_id, grams_per_serving, calories, protein
FROM ingredients
WHERE name LIKE '%yogurt%';
```

```sql
INSERT INTO ingredients (
  name, food_id, serving_id, grams_per_serving,
  calories, protein, carbs, fat, fiber, aliases
) VALUES (
  'Greek Yogurt', 123, 456, 170,
  100, 17, 6, 0.7, 0, '["greek yogurt","plain yogurt"]'
);
```

## Output

Returns the underlying command output in `result`.
