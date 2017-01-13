/*
Copyright 2015, 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/**
 * @module pushprocessor
 */

/**
 * Construct a Push Processor.
 * @constructor
 * @param {Object} client The Matrix client object to use
 */
function PushProcessor(client) {
    let escapeRegExp = function(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    let matchingRuleFromKindSet = function(ev, kindset, device) {
        let rulekinds_in_order = ['override', 'content', 'room', 'sender', 'underride'];
        for (let ruleKindIndex = 0;
                ruleKindIndex < rulekinds_in_order.length;
                ++ruleKindIndex) {
            let kind = rulekinds_in_order[ruleKindIndex];
            let ruleset = kindset[kind];

            for (let ruleIndex = 0; ruleIndex < ruleset.length; ++ruleIndex) {
                let rule = ruleset[ruleIndex];
                if (!rule.enabled) {
 continue;
}

                let rawrule = templateRuleToRaw(kind, rule, device);
                if (!rawrule) {
 continue;
}

                if (ruleMatchesEvent(rawrule, ev)) {
                    rule.kind = kind;
                    return rule;
                }
            }
        }
        return null;
    };

    let templateRuleToRaw = function(kind, tprule, device) {
        let rawrule = {
            'rule_id': tprule.rule_id,
            'actions': tprule.actions,
            'conditions': [],
        };
        switch (kind) {
            case 'underride':
            case 'override':
                rawrule.conditions = tprule.conditions;
                break;
            case 'room':
                if (!tprule.rule_id) {
 return null;
}
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'room_id',
                    'pattern': tprule.rule_id,
                });
                break;
            case 'sender':
                if (!tprule.rule_id) {
 return null;
}
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'user_id',
                    'pattern': tprule.rule_id,
                });
                break;
            case 'content':
                if (!tprule.pattern) {
 return null;
}
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'content.body',
                    'pattern': tprule.pattern,
                });
                break;
        }
        if (device) {
            rawrule.conditions.push({
                'kind': 'device',
                'profile_tag': device,
            });
        }
        return rawrule;
    };

    let ruleMatchesEvent = function(rule, ev) {
        let ret = true;
        for (let i = 0; i < rule.conditions.length; ++i) {
            let cond = rule.conditions[i];
            ret &= eventFulfillsCondition(cond, ev);
        }
        //console.log("Rule "+rule.rule_id+(ret ? " matches" : " doesn't match"));
        return ret;
    };

    let eventFulfillsCondition = function(cond, ev) {
        let condition_functions = {
            "event_match": eventFulfillsEventMatchCondition,
            "device": eventFulfillsDeviceCondition,
            "contains_display_name": eventFulfillsDisplayNameCondition,
            "room_member_count": eventFulfillsRoomMemberCountCondition,
        };
        if (condition_functions[cond.kind]) {
            return condition_functions[cond.kind](cond, ev);
        }
        return true;
    };

    let eventFulfillsRoomMemberCountCondition = function(cond, ev) {
        if (!cond.is) {
 return false;
}

        let room = client.getRoom(ev.getRoomId());
        if (!room || !room.currentState || !room.currentState.members) {
 return false;
}

        let memberCount = Object.keys(room.currentState.members).filter(function(m) {
            return room.currentState.members[m].membership == 'join';
        }).length;

        let m = cond.is.match(/^([=<>]*)([0-9]*)$/);
        if (!m) {
 return false;
}
        let ineq = m[1];
        let rhs = parseInt(m[2]);
        if (isNaN(rhs)) {
 return false;
}
        switch (ineq) {
            case '':
            case '==':
                return memberCount == rhs;
            case '<':
                return memberCount < rhs;
            case '>':
                return memberCount > rhs;
            case '<=':
                return memberCount <= rhs;
            case '>=':
                return memberCount >= rhs;
            default:
                return false;
        }
    };

    let eventFulfillsDisplayNameCondition = function(cond, ev) {
        let content = ev.getContent();
        if (!content || !content.body || typeof content.body != 'string') {
            return false;
        }

        let room = client.getRoom(ev.getRoomId());
        if (!room || !room.currentState || !room.currentState.members ||
            !room.currentState.getMember(client.credentials.userId)) {
 return false;
}

        let displayName = room.currentState.getMember(client.credentials.userId).name;

        // N.B. we can't use \b as it chokes on unicode. however \W seems to be okay
        // as shorthand for [^0-9A-Za-z_].
        let pat = new RegExp("(^|\\W)" + escapeRegExp(displayName) + "(\\W|$)", 'i');
        return content.body.search(pat) > -1;
    };

    let eventFulfillsDeviceCondition = function(cond, ev) {
        return false; // XXX: Allow a profile tag to be set for the web client instance
    };

    let eventFulfillsEventMatchCondition = function(cond, ev) {
        let val = valueForDottedKey(cond.key, ev);
        if (!val || typeof val != 'string') {
 return false;
}

        let pat;
        if (cond.key == 'content.body') {
            pat = '(^|\\W)' + globToRegexp(cond.pattern) + '(\\W|$)';
        } else {
            pat = '^' + globToRegexp(cond.pattern) + '$';
        }
        let regex = new RegExp(pat, 'i');
        return !!val.match(regex);
    };

    let globToRegexp = function(glob) {
        // From
        // https://github.com/matrix-org/synapse/blob/abbee6b29be80a77e05730707602f3bbfc3f38cb/synapse/push/__init__.py#L132
        // Because micromatch is about 130KB with dependencies,
        // and minimatch is not much better.
        let pat = escapeRegExp(glob);
        pat = pat.replace(/\\\*/, '.*');
        pat = pat.replace(/\?/, '.');
        pat = pat.replace(/\\\[(!|)(.*)\\]/, function(match, p1, p2, offset, string) {
            let first = p1 && '^' || '';
            let second = p2.replace(/\\\-/, '-');
            return '[' + first + second + ']';
        });
        return pat;
    };

    let valueForDottedKey = function(key, ev) {
        let parts = key.split('.');
        let val;

        // special-case the first component to deal with encrypted messages
        let firstPart = parts[0];
        if (firstPart == 'content') {
            val = ev.getContent();
            parts.shift();
        } else if (firstPart == 'type') {
            val = ev.getType();
            parts.shift();
        } else {
            // use the raw event for any other fields
            val = ev.event;
        }

        while (parts.length > 0) {
            let thispart = parts.shift();
            if (!val[thispart]) {
 return null;
}
            val = val[thispart];
        }
        return val;
    };

    let matchingRuleForEventWithRulesets = function(ev, rulesets) {
        if (!rulesets || !rulesets.device) {
 return null;
}
        if (ev.getSender() == client.credentials.userId) {
 return null;
}

        let allDevNames = Object.keys(rulesets.device);
        for (let i = 0; i < allDevNames.length; ++i) {
            let devname = allDevNames[i];
            let devrules = rulesets.device[devname];

            let matchingRule = matchingRuleFromKindSet(devrules, devname);
            if (matchingRule) {
 return matchingRule;
}
        }
        return matchingRuleFromKindSet(ev, rulesets.global);
    };

    let pushActionsForEventAndRulesets = function(ev, rulesets) {
        let rule = matchingRuleForEventWithRulesets(ev, rulesets);
        if (!rule) {
 return {};
}

        let actionObj = PushProcessor.actionListToActionsObject(rule.actions);

        // Some actions are implicit in some situations: we add those here
        if (actionObj.tweaks.highlight === undefined) {
            // if it isn't specified, highlight if it's a content
            // rule but otherwise not
            actionObj.tweaks.highlight = (rule.kind == 'content');
        }

        return actionObj;
    };

    /**
     * Get the user's push actions for the given event
     *
     * @param {module:models/event.MatrixEvent} ev
     *
     * @return {PushAction}
     */
    this.actionsForEvent = function(ev) {
        return pushActionsForEventAndRulesets(ev, client.pushRules);
    };
}

/**
 * Convert a list of actions into a object with the actions as keys and their values
 * eg. [ 'notify', { set_tweak: 'sound', value: 'default' } ]
 *     becomes { notify: true, tweaks: { sound: 'default' } }
 * @param {array} actionlist The actions list
 *
 * @return {object} A object with key 'notify' (true or false) and an object of actions
 */
PushProcessor.actionListToActionsObject = function(actionlist) {
    let actionobj = { 'notify': false, 'tweaks': {} };
    for (let i = 0; i < actionlist.length; ++i) {
        let action = actionlist[i];
        if (action === 'notify') {
            actionobj.notify = true;
        } else if (typeof action === 'object') {
            if (action.value === undefined) {
 action.value = true;
}
            actionobj.tweaks[action.set_tweak] = action.value;
        }
    }
    return actionobj;
};

/**
 * @typedef {Object} PushAction
 * @type {Object}
 * @property {boolean} notify Whether this event should notify the user or not.
 * @property {Object} tweaks How this event should be notified.
 * @property {boolean} tweaks.highlight Whether this event should be highlighted
 * on the UI.
 * @property {boolean} tweaks.sound Whether this notification should produce a
 * noise.
 */

/** The PushProcessor class. */
module.exports = PushProcessor;

