'use strict';

const assert = require('assert');
const util = require('util');
const Tokenizer = require('../lib/tokenizer');
const LocationInfoTokenizerMixin = require('../lib/extensions/location-info/tokenizer-mixin');
const Mixin = require('../lib/utils/mixin');
const { getSubstringByLineCol, normalizeNewLine, addSlashes } = require('../../../test/utils/common');

// cross product of two arrays
function cross(arr1, arr2) {
    const res = [];
    for (const a of arr1) {
        for (const b of arr2) {
            res.push([a, b]);
        }
    }
    return res;
}

const testCases = [
    {
        description: 'complete document',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: '',
        htmlChunks: [
            '\r\n',
            '<!DOCTYPE html>',
            '\n',
            '<!-- Test -->',
            '\n',
            '<head>',
            '\n   ',
            '<meta charset="utf-8">',
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
    },
    {
        initialMode: Tokenizer.MODE.RCDATA,
        lastStartTagName: 'title',
        htmlChunks: ['<div>Test', ' \n   ', 'hey', ' ', 'ya!', '</title>', '<!--Yo-->']
    },
    {
        initialMode: Tokenizer.MODE.RAWTEXT,
        lastStartTagName: 'style',
        htmlChunks: ['.header{', ' \n   ', 'color:red;', '\n', '}', '</style>', 'Some', ' ', 'text']
    },
    {
        initialMode: Tokenizer.MODE.SCRIPT_DATA,
        lastStartTagName: 'script',
        htmlChunks: ['var', ' ', 'a=c', ' ', '-', ' ', 'd;', '\n', 'a<--d;', '</script>', '<div>']
    },
    {
        initialMode: Tokenizer.MODE.PLAINTEXT,
        lastStartTagName: 'plaintext',
        htmlChunks: ['Text', ' \n', 'Test</plaintext><div>']
    },
    {
        description: 'non-whiteSpace char ref after whitespace',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: 'body',
        htmlChunks: cross(['\f', '\t', '\n', ' '], ['&lt;', '&#60;', '&#x60;']).reduce((acc, e) => acc.concat(e), []) // flatten
    },
    {
        description: '&nbsp; after whitespace',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: 'body',
        htmlChunks: cross(['\f', '\t', '\n', ' '], ['&nbsp;', '&#160;', '&#xA0;']).reduce((acc, e) => acc.concat(e), []) // flatten
    },
    {
        description: 'whiteSpace char ref after whitespace',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: 'body',
        htmlChunks: [
            cross(
                ['\f', '\t', '\n', ' '],
                ['&Tab;', '&#9;', '&#x9;', '&NewLine;', '&#10;', '&#xA;', '&#12;', '&#xC;', '&#32;', '&#x20;']
            )
                .map(pair => pair.join(''))
                .join('')
        ]
    },
    {
        description: 'non-whiteSpace char ref after non-whitespace',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: 'body',
        htmlChunks: ['foo&lt;bar&#60;qmbl&#x3C;']
    },
    {
        description: '&nbsp; after non-whitespace',
        initialMode: Tokenizer.MODE.DATA,
        lastStartTagName: 'body',
        htmlChunks: ['foo&nbsp;bar&#160;qmbl&#xA0;']
    }
];

testCases.forEach((testCase, idx) => {
    const testName =
        `Location info (Tokenizer) ${idx}.` +
        ` - [${testCase.initialMode}/${testCase.lastStartTagName}]` +
        ` ${testCase.description || ''}`;
    exports[testName] = function() {
        const html = testCase.htmlChunks.join('');
        const lines = html.split(/\r?\n/g);
        const tokenizer = new Tokenizer();
        const lastChunkIdx = testCase.htmlChunks.length - 1;

        Mixin.install(tokenizer, LocationInfoTokenizerMixin);

        for (let i = 0; i < testCase.htmlChunks.length; i++) {
            tokenizer.write(testCase.htmlChunks[i], i === lastChunkIdx);
        }

        // NOTE: set small waterline for testing purposes
        tokenizer.preprocessor.bufferWaterline = 8;
        tokenizer.state = testCase.initialMode;
        tokenizer.lastStartTagName = testCase.lastStartTagName;

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

            const srcChunk = testCase.htmlChunks[j++];

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

            const tokensStr = `\n\ncurrent token: ${util.inspect(currentToken)}\nnext token: ${util.inspect(
                nextToken
            )}\n`;
            assert.deepStrictEqual(
                currentToken.location,
                exp,
                `location @ source chunk #${j - 1}` +
                    `\nchunk #${j - 1}: '${addSlashes(srcChunk)}'` +
                    `\ntoken #${j - 1}: ${util.inspect(currentToken)}\n` +
                    `\nchunk #${j}: ${
                        j == testCase.htmlChunks.length ? '-' : "'" + addSlashes(testCase.htmlChunks[j]) + "'"
                    }` +
                    `\ntoken #${j}: ${util.inspect(nextToken)}\n`
            );

            // // The old assertions; comment-in for sanity-checking
            // //Offsets
            // let actual = html.substring(currentToken.location.startOffset, currentToken.location.endOffset);
            // let expected = srcChunk;
            // assert.strictEqual(actual, expected);

            // //Line/col
            // actual = getSubstringByLineCol(lines, currentToken.location);
            // expected = normalizeNewLine(srcChunk);
            // assert.strictEqual(actual, expected);
        }
    };
});
