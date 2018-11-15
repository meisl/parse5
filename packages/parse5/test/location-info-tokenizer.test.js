'use strict';

const assert = require('assert');
const util = require('util');
const Tokenizer = require('../lib/tokenizer');
const LocationInfoTokenizerMixin = require('../lib/extensions/location-info/tokenizer-mixin');
const Mixin = require('../lib/utils/mixin');
const { getSubstringByLineCol, normalizeNewLine, addSlashes } = require('../../../test/utils/common');

const MODE = Tokenizer.MODE;

/* helpers: array massaging */

function crossProduct(arr1, arr2) {
    const res = [];
    for (const a of arr1) {
        for (const b of arr2) {
            res.push([a, b]);
        }
    }
    res.flatten = flatten;
    return res;
}

function flatten() {
    return this.reduce((acc, elem) => acc.concat(elem), []);
}

/* Test cases: {
 *     [description: string]: [
 *          initialMode: Tokenizer.MODE,
 *          lastStartTagName: string,
 *          htmlChunks: [string|[string]]
 *      ]
 * }
 * To skip a particular test, just prefix `description` with `//`; it'll be marked as 'TODO:...'.
 * `htmlChunks` defines both, the input text and the expected tokens together
 * with their locations.
 * - the input text is simply all the chunks concatenated together 
 *   (if a chunk is itself an array, *its* elements get concatenated first)
 * - each chunk corresponds to exactly one token that the tokenizer is expected
 *   to emit.
 *   * string chunks: expected location is calculated from length (and previous chunks)
 *   * array chunks: these imply an expected START_TAG_TOKEN, which has additional
 *     location info for attributes.
 */

const testCases = {
    'complete document': [
        MODE.DATA,
        '',
        [
            '\r\n',
            '<!DOCTYPE html>',
            '\n',
            '<!-- Test -->',
            '\n',
            '<head>',
            '\n   ',
            '<meta charset="utf-8">',
            ['<meta ', 'charset="utf-8"', '>'],
            '<title>',
            '   ',
            'node.js',
            '\u0000',
            '</title>',
            '\n',
            '</head>',
            '\n',
            '<body id="front">',
            '\n',
            '<div id="intro">',
            '\n   ',
            '<p\n>',
            '\n       ',
            'Node.js',
            ' ',
            'is',
            ' ',
            'a',
            '\n       ',
            'platform',
            ' ',
            'built',
            ' ',
            'on',
            '\n       ',
            '<a href="http://code.google.com/p/v8/">',
            '\n       ',
            "Chrome's",
            ' ',
            'JavaScript',
            ' ',
            'runtime',
            '\n       ',
            '</a>',
            '\n',
            '</div>',
            '</body>'
        ]
    ],
    'from inside <title>': [MODE.RCDATA, 'title', ['<div>Test', ' \n   ', 'hey', ' ', 'ya!', '</title>', '<!--Yo-->']],
    'inside <style>': [
        MODE.RAWTEXT,
        'style',
        ['.header{', ' \n   ', 'color:red;', '\n', '}', '</style>', 'Some', ' ', 'text']
    ],
    'inside <script>': [
        MODE.SCRIPT_DATA,
        'script',
        ['var', ' ', 'a=c', ' ', '-', ' ', 'd;', '\n', 'a<--d;', '</script>', '<div>']
    ],
    'after <plaintext>': [MODE.PLAINTEXT, 'plaintext', ['Text', ' \n', 'Test</plaintext><div>']],
    'non-whiteSpace char ref after whitespace': [
        MODE.DATA,
        'body',
        crossProduct(['\f', '\t', '\n', ' '], ['&lt;', '&#60;', '&#x60;']).flatten()
    ],
    '&nbsp; after whitespace': [
        MODE.DATA,
        'body',
        crossProduct(['\f', '\t', '\n', ' '], ['&nbsp;', '&#160;', '&#xA0;']).flatten()
    ],
    'whiteSpace char ref after whitespace': [
        MODE.DATA,
        'body',
        [
            crossProduct(
                ['\f', '\t', '\n', ' '],
                ['&Tab;', '&#9;', '&#x9;', '&NewLine;', '&#10;', '&#xA;', '&#12;', '&#xC;', '&#32;', '&#x20;']
            )
                .flatten()
                .join('')
        ]
    ],
    'non-whiteSpace char ref after non-whitespace': [MODE.DATA, 'body', ['foo&lt;bar&#60;qmbl&#x3C;']],
    '&nbsp; after non-whitespace': [MODE.DATA, 'body', ['foo&nbsp;bar&#160;qmbl&#xA0;']]
};

for (const [description, [initialMode, lastStartTagName, htmlChunks]] of Object.entries(testCases)) {
    const testIdx = Object.keys(exports).length;
    let testName = `Location info (Tokenizer) ${testIdx}` + ` - [${initialMode}/${lastStartTagName}]`;
    if (description.startsWith('//')) {
        testName = 'TODO: ' + testName + ' ' + description.substring(2).trim();
        exports[testName] = () => assert.ok(true);
    } else {
        testName += ' ' + description;
        // exports[testName] = mkTest(initialMode, lastStartTagName, htmlChunks);
        exports[testName] = () => {
            const tokenizer = new Tokenizer();

            Mixin.install(tokenizer, LocationInfoTokenizerMixin);

            htmlChunks.forEach(chunk => tokenizer.write(chunk, false));
            tokenizer.write('', true);

            // NOTE: set small waterline for testing purposes
            tokenizer.preprocessor.bufferWaterline = 8;
            tokenizer.state = initialMode;
            tokenizer.lastStartTagName = lastStartTagName;

            let exp = {
                startOffset: 0,
                startLine: 1,
                startCol: 1,
                endOffset: 0,
                endLine: 1,
                endCol: 1
            };

            let nextToken = tokenizer.getNextToken();
            let j = 0;
            while (nextToken.type !== Tokenizer.EOF_TOKEN) {
                let currentToken = nextToken;
                nextToken = tokenizer.getNextToken();
                if (currentToken.type === Tokenizer.HIBERNATION_TOKEN) {
                    continue;
                }

                const srcChunk = htmlChunks[j++];

                exp.startOffset = exp.endOffset;
                exp.endOffset += srcChunk.length;
                // The \n itself - emitted as (part of) a WHITESPACE_CHARACTER_TOKEN - is considered
                // the very last character of a line, and the new line starts right after it.
                // Therefore the next token's startLine is the previous token's endLine,
                // and likewise for startCol and endCol.
                exp.startLine = exp.endLine;
                exp.startCol = exp.endCol;
                for (const ch of srcChunk) {
                    if (ch === '\n') {
                        exp.endCol = 1;
                        exp.endLine++;
                    } else {
                        exp.endCol++;
                    }
                }

                assert.deepStrictEqual(
                    currentToken.location,
                    exp,
                    `location @ source chunk #${j - 1}` +
                        `\nchunk #${j - 1}: '${addSlashes(srcChunk)}'` +
                        `\ntoken #${j - 1}: ${util.inspect(currentToken)}\n` +
                        `\nchunk #${j}: ${j == htmlChunks.length ? '-' : "'" + addSlashes(htmlChunks[j]) + "'"}` +
                        `\ntoken #${j}: ${util.inspect(nextToken)}\n`
                );

                // The old assertions; un-comment for sanity-checking
                const html = htmlChunks.join('');
                const lines = html.split(/\r?\n/g);

                //Offsets
                let actual = html.substring(currentToken.location.startOffset, currentToken.location.endOffset);
                let expected = srcChunk;
                assert.strictEqual(actual, expected);

                //Line/col
                actual = getSubstringByLineCol(lines, currentToken.location);
                expected = normalizeNewLine(srcChunk);
                assert.strictEqual(actual, expected);
            }
        };
    }
}
