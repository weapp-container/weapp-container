const freeze=value=>{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value)};return value}
export const expectedSnapshot=freeze({
  "objectCaptures": [
    {
      "id": "missing",
      "label": "section-fallback",
      "rest": {
        "extra": "A"
      },
      "restKeys": [
        "extra"
      ],
      "rowIndex": 0,
      "sectionName": "section-fallback"
    },
    {
      "id": "null",
      "label": null,
      "rest": {
        "extra": "B"
      },
      "restKeys": [
        "extra"
      ],
      "rowIndex": 1,
      "sectionName": "section-fallback"
    },
    {
      "id": "zero",
      "label": 0,
      "rest": {
        "extra": "C"
      },
      "restKeys": [
        "extra"
      ],
      "rowIndex": 2,
      "sectionName": "section-fallback"
    },
    {
      "id": "false",
      "label": false,
      "rest": {
        "extra": "D"
      },
      "restKeys": [
        "extra"
      ],
      "rowIndex": 3,
      "sectionName": "section-fallback"
    }
  ],
  "tupleCaptures": [
    {
      "head": "head",
      "tail": [
        "tail-a",
        "tail-b"
      ],
      "tupleIndex": 0
    }
  ]
})
export const expectedDomCheckpoints=freeze([
  {
    "id": "initial",
    "nodes": [
      {
        "selector": "#issue1011-value-missing",
        "text": "missing|section-fallback|A|excluded|excluded"
      },
      {
        "selector": "#issue1011-value-null",
        "text": "null|null|B|excluded|excluded"
      },
      {
        "selector": "#issue1011-value-zero",
        "text": "zero|0|C|excluded|excluded"
      },
      {
        "selector": "#issue1011-value-false",
        "text": "false|false|D|excluded|excluded"
      },
      {
        "selector": "#issue1011-tuple-0",
        "text": "head|tail-a|tail-b"
      },
      {
        "selector": "#issue1011-capture-count",
        "text": "0"
      }
    ]
  },
  {
    "id": "captured",
    "nodes": [
      {
        "selector": "#issue1011-capture-count",
        "text": "5"
      }
    ]
  }
])
