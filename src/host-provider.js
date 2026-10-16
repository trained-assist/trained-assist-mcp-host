'use strict';
const search = require('./search');
const vendor = require('./vendor/trained-assist-search-skill/069ba8b2e6f8b02c4e9241fcb1514d3114a68466/src/host-provider');
module.exports = vendor;
module.exports.createSearchProvider = search.createSearchProvider;
